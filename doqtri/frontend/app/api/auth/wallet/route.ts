import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  isStellarPublicKey,
  walletEmail,
  walletPassword,
} from "@/lib/wallet-auth";
import { verifyWalletChallenge } from "@/lib/wallet-challenge";

/**
 * Bridge Stellar wallet → Supabase session.
 *
 * The caller must prove it controls the wallet: `token` comes from
 * POST /api/auth/wallet/challenge and `signature` is the wallet's SEP-53
 * signature of that challenge's message. An address alone is public
 * information and never opens a session.
 *
 * Idempotent: any number of calls for the same public key, including
 * concurrent ones from two tabs, end in a session for the same user. The
 * password is derived from the address, so every path converges on one
 * sign-in; the branches only exist to create or repair the user first.
 */
export async function POST(request: Request) {
  let body: { address?: string; token?: string; signature?: string };
  try {
    body = (await request.json()) as { address?: string; token?: string; signature?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const address = body.address?.trim();
  if (!address || !isStellarPublicKey(address)) {
    return Response.json({ error: "Invalid Stellar address" }, { status: 400 });
  }

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return Response.json({ error: "Server is not configured" }, { status: 500 });
  if (!body.token || !body.signature) {
    return Response.json({ error: "Sign the login message with your wallet to continue." }, { status: 401 });
  }
  const proof = verifyWalletChallenge({ address, token: body.token, signature: body.signature }, secret);
  if (!proof.ok) {
    const error =
      proof.reason === "expired"
        ? "The login request expired. Connect your wallet again."
        : "Wallet signature could not be verified.";
    return Response.json({ error }, { status: 401 });
  }

  const email = walletEmail(address);
  const password = walletPassword(address);
  const admin = createSupabaseAdminClient();
  const authClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const signIn = async (): Promise<Session | null> =>
    (await authClient.auth.signInWithPassword({ email, password })).data.session;

  const ok = (session: Session) => {
    return Response.json({
      address,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
  };

  // 1. The common case: the user exists and the derived password matches.
  let session = await signIn();
  if (session) {
    await rememberWalletUser(admin, address, session.user.id);
    return ok(session);
  }

  // 2. Known wallet whose password no longer matches (e.g. a rotated secret):
  //    repair it by id, found by primary key rather than a user scan.
  let userId = await findWalletUser(admin, address, email);

  if (!userId) {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { wallet_address: address },
    });

    if (created?.user) {
      await rememberWalletUser(admin, address, created.user.id);
      session = await signIn();
      if (session) return ok(session);
      return Response.json({ error: "Failed to create session" }, { status: 500 });
    }

    const already =
      /already|registered|exists/i.test(createError?.message ?? "") ||
      createError?.status === 422;
    if (!already) {
      return Response.json(
        { error: createError?.message ?? "Could not create wallet user" },
        { status: 500 },
      );
    }

    // 3. Lost a race with a concurrent request for the same wallet: it created
    //    the user with this same password, so signing in now just works.
    session = await signIn();
    if (session) {
      await rememberWalletUser(admin, address, session.user.id);
      return ok(session);
    }
    userId = await findWalletUser(admin, address, email, { scan: true });
    if (!userId) {
      return Response.json(
        { error: "Wallet user exists but could not be loaded" },
        { status: 500 },
      );
    }
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
    password,
    email_confirm: true,
    user_metadata: { wallet_address: address },
  });
  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 });
  }
  await rememberWalletUser(admin, address, userId);

  session = await signIn();
  if (!session) {
    return Response.json({ error: "Failed to create session" }, { status: 500 });
  }
  return ok(session);
}

/**
 * Looks the wallet up in `wallet_accounts`. With `scan`, falls back to paging
 * through every auth user — needed for wallets created before the mapping
 * table existed, or while its migration is not applied yet.
 */
async function findWalletUser(
  admin: SupabaseClient,
  address: string,
  email: string,
  options: { scan?: boolean } = {},
): Promise<string | null> {
  const { data } = await admin
    .from("wallet_accounts")
    .select("user_id")
    .eq("address", address)
    .maybeSingle();
  if (data?.user_id) return data.user_id as string;
  if (!options.scan) return null;

  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data: listed, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return null;
    const match = listed.users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match.id;
    if (listed.users.length < perPage) return null;
  }
}

/** Best-effort: the mapping only speeds up repair, so a failed write is not fatal. */
async function rememberWalletUser(
  admin: SupabaseClient,
  address: string,
  userId: string,
): Promise<void> {
  const { error } = await admin
    .from("wallet_accounts")
    .upsert({ address, user_id: userId }, { onConflict: "address", ignoreDuplicates: true });
  if (error) console.warn(`[auth/wallet] mapping not saved: ${error.message}`);
}
