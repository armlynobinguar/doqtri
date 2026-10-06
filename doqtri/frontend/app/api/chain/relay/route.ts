import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { walletAddressFromEmail } from "@/lib/wallet-address";
import { CONTRACT_ID, NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import {
  NETWORK,
  SHARED_DEPLOYER_SEED,
  SMART_ACCOUNT_WASM_HASH,
  THRESHOLD_POLICY,
  WEBAUTHN_VERIFIER,
} from "@/lib/stellar/smart-wallet-config";
import {
  deployedContractAddress,
  deployerAddress,
  parseRelayBody,
  RelayRejection,
  validateRegistryWrite,
  validateWalletDeploy,
  type RelaySubmission,
} from "@/lib/stellar/relay-validation";
import { simulateWithinCap, submitAndConfirm } from "@/lib/stellar/channels";

/**
 * Fee-sponsored submission for passkey smart wallets (progress/002).
 *
 * smart-account-kit's RelayerClient posts `{ func, auth }` here and expects
 * `{ success, data: { transactionId, hash, status } }` or `{ success: false,
 * error }`. Every request spends Doqtri's Channels allowance, so it must come
 * from a signed-in email account, pass the shape checks in relay-validation,
 * fit the per-user and global quota, and simulate under the fee cap.
 *
 * Two kinds of submission: a wallet deployment, and a DoqtriRegistry write
 * signed by the caller's own wallet for one of the caller's own notes. Each
 * relayed write is indexed in chain_writes, because Horizon cannot list a
 * contract account's writes by owner.
 */

const DEPLOYS_PER_USER = positive(process.env.CHAIN_DEPLOYS_PER_USER_DAILY, 3);
const DEPLOYS_GLOBAL = positive(process.env.CHAIN_DEPLOYS_GLOBAL_DAILY, 200);
const WRITES_PER_USER = positive(process.env.CHAIN_WRITES_PER_USER_DAILY, 100);
const WRITES_GLOBAL = positive(process.env.CHAIN_WRITES_GLOBAL_DAILY, 5000);

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function fail(error: string, status: number, extra: Record<string, unknown> = {}) {
  return Response.json({ success: false, error, ...extra }, { status });
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Sign in to continue.", 401);
  // Wallet accounts sign and pay with their own Stellar account.
  if (walletAddressFromEmail(user.email)) return fail("This relay is for email accounts.", 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON", 400);
  }

  try {
    const submission = parseRelayBody(body);
    if (submission.func.switch().name === "hostFunctionTypeCreateContractV2") {
      return await deployWallet(user.id, submission, new URL(request.url).hostname);
    }
    return await relayRegistryWrite(user.id, submission);
  } catch (error) {
    if (error instanceof RelayRejection) return fail(error.message, error.status);
    console.error("[chain/relay] unexpected error", error);
    return fail("Something went wrong submitting this transaction.", 500);
  }
}

/** Charges one request against the quota; null when allowed, else a refusal. */
async function chargeQuota(
  userId: string,
  kind: "deploy" | "write",
  userLimit: number,
  globalLimit: number,
): Promise<Response | null> {
  const { data, error } = await createSupabaseAdminClient().rpc("consume_chain_quota", {
    p_user_id: userId,
    p_network: NETWORK,
    p_kind: kind,
    p_user_limit: userLimit,
    p_global_limit: globalLimit,
  });
  const row = (data as { allowed: boolean; scope: string | null }[] | null)?.[0];
  if (error || !row) {
    console.error(`[chain/relay] quota check failed: ${error?.message ?? "no row"}`);
    return fail("On-chain actions are temporarily unavailable.", 503);
  }
  if (row.allowed) return null;
  if (row.scope === "global") return fail("Doqtri's on-chain actions are paused for today. Try again tomorrow.", 429);
  return fail(
    kind === "deploy"
      ? "You've reached today's limit for creating a wallet."
      : "You've reached today's limit for on-chain actions.",
    429,
  );
}

async function relayRegistryWrite(userId: string, submission: RelaySubmission) {
  const admin = createSupabaseAdminClient();

  const { data: wallet } = await admin
    .from("smart_wallets")
    .select("address")
    .eq("user_id", userId)
    .eq("network", NETWORK)
    .maybeSingle();
  if (!wallet) return fail("Create your passkey wallet first.", 409);

  const write = validateRegistryWrite(submission, { registry: CONTRACT_ID, wallet: wallet.address });

  // The contract checks the signature; this checks the note is the caller's,
  // so nobody can anchor (and spend fees on) arbitrary document ids.
  const { data: doc } = await admin
    .from("documents")
    .select("id")
    .eq("id", write.docId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!doc) return fail("That note isn't in your vault.", 403);

  const refused = await chargeQuota(userId, "write", WRITES_PER_USER, WRITES_GLOBAL);
  if (refused) return refused;

  await simulateWithinCap(submission.func, submission.auth);
  const sent = await submitAndConfirm(submission.func, submission.auth);

  const { error } = await admin.from("chain_writes").insert({
    network: NETWORK,
    tx_hash: sent.hash,
    document_id: write.docId,
    fn: write.fn,
    owner: wallet.address,
  });
  // The write is on-chain either way; a missing index row only hides it from
  // the history list until reconciled, so report success and log loudly.
  if (error) console.error(`[chain/relay] ${write.fn} ${sent.hash} not indexed: ${error.message}`);

  return Response.json({ success: true, data: sent });
}

async function deployWallet(userId: string, submission: RelaySubmission, rpId: string) {
  const admin = createSupabaseAdminClient();

  const { data: existing } = await admin
    .from("smart_wallets")
    .select("address")
    .eq("user_id", userId)
    .eq("network", NETWORK)
    .maybeSingle();
  if (existing) return fail("You already have a wallet.", 409, { address: existing.address });

  const deploy = validateWalletDeploy(submission, {
    accountWasmHash: SMART_ACCOUNT_WASM_HASH,
    webauthnVerifier: WEBAUTHN_VERIFIER,
    thresholdPolicy: THRESHOLD_POLICY,
    deployer: deployerAddress(SHARED_DEPLOYER_SEED),
  });

  // Charged after validation, so a malformed request costs nothing.
  const refused = await chargeQuota(userId, "deploy", DEPLOYS_PER_USER, DEPLOYS_GLOBAL);
  if (refused) return refused;

  await simulateWithinCap(submission.func, submission.auth);
  const sent = await submitAndConfirm(submission.func, submission.auth);

  const address = deployedContractAddress(deploy.deployer, deploy.salt, NETWORK_PASSPHRASE);
  const { error: walletError } = await admin.from("smart_wallets").insert({
    user_id: userId,
    network: NETWORK,
    address,
    created_tx: sent.hash,
  });
  if (walletError) {
    // The wallet exists on-chain regardless; log so it can be reconciled.
    console.error(`[chain/relay] wallet ${address} deployed (${sent.hash}) but not recorded: ${walletError.message}`);
  } else {
    const { error: passkeyError } = await admin.from("wallet_passkeys").insert({
      credential_id: deploy.credentialId.toString("base64url"),
      user_id: userId,
      network: NETWORK,
      public_key: `\\x${deploy.publicKey.toString("hex")}`,
      rp_id: rpId,
    });
    if (passkeyError) console.error(`[chain/relay] passkey for ${address} not recorded: ${passkeyError.message}`);
  }

  return Response.json({ success: true, data: sent });
}
