import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { walletAddressFromEmail } from "@/lib/wallet-address";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";
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
 * Phase 3 accepts wallet deployments only. Registry writes (phase 4) are
 * refused until their own validation lands.
 */

const DEPLOYS_PER_USER = positive(process.env.CHAIN_DEPLOYS_PER_USER_DAILY, 3);
const DEPLOYS_GLOBAL = positive(process.env.CHAIN_DEPLOYS_GLOBAL_DAILY, 200);

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
    return fail("Only wallet creation is supported so far.", 403);
  } catch (error) {
    if (error instanceof RelayRejection) return fail(error.message, error.status);
    console.error("[chain/relay] unexpected error", error);
    return fail("Something went wrong submitting this transaction.", 500);
  }
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
  const { data: quota, error: quotaError } = await admin.rpc("consume_chain_quota", {
    p_user_id: userId,
    p_network: NETWORK,
    p_kind: "deploy",
    p_user_limit: DEPLOYS_PER_USER,
    p_global_limit: DEPLOYS_GLOBAL,
  });
  const row = (quota as { allowed: boolean; scope: string | null }[] | null)?.[0];
  if (quotaError || !row) {
    console.error(`[chain/relay] quota check failed: ${quotaError?.message ?? "no row"}`);
    return fail("Wallet creation is temporarily unavailable.", 503);
  }
  if (!row.allowed) {
    return fail(
      row.scope === "global"
        ? "Wallet creation is paused for today. Try again tomorrow."
        : "You've reached today's limit for creating a wallet.",
      429,
    );
  }

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
