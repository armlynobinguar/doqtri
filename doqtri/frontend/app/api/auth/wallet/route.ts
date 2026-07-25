import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import {
  isStellarPublicKey,
  walletEmail,
  walletPassword,
} from "@/lib/wallet-auth";

/**
 * Bridge Stellar wallet → Supabase session.
 * Ensures a confirmed user exists for the public key, then returns tokens
 * for the browser client to `setSession`.
 */
export async function POST(request: Request) {
  let body: { address?: string };
  try {
    body = (await request.json()) as { address?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const address = body.address?.trim();
  if (!address || !isStellarPublicKey(address)) {
    return Response.json({ error: "Invalid Stellar address" }, { status: 400 });
  }

  const email = walletEmail(address);
  const password = walletPassword(address);
  const admin = createSupabaseAdminClient();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const authClient = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let session = (
    await authClient.auth.signInWithPassword({ email, password })
  ).data.session;

  if (!session) {
    const { error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { wallet_address: address },
    });

    if (createError) {
      const already =
        /already|registered|exists/i.test(createError.message) ||
        createError.status === 422;
      if (!already) {
        return Response.json({ error: createError.message }, { status: 500 });
      }

      // User exists but password may be stale — reset it.
      const { data: listed, error: listError } =
        await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (listError) {
        return Response.json({ error: listError.message }, { status: 500 });
      }
      const existing = listed.users.find(
        (u) => u.email?.toLowerCase() === email.toLowerCase(),
      );
      if (!existing) {
        return Response.json(
          { error: "Wallet user exists but could not be loaded" },
          { status: 500 },
        );
      }
      const { error: updateError } = await admin.auth.admin.updateUserById(
        existing.id,
        {
          password,
          email_confirm: true,
          user_metadata: {
            ...existing.user_metadata,
            wallet_address: address,
          },
        },
      );
      if (updateError) {
        return Response.json({ error: updateError.message }, { status: 500 });
      }
    }

    const signedIn = await authClient.auth.signInWithPassword({
      email,
      password,
    });
    session = signedIn.data.session;
    if (signedIn.error || !session) {
      return Response.json(
        { error: signedIn.error?.message ?? "Failed to create session" },
        { status: 500 },
      );
    }
  }

  return Response.json({
    address,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
}
