import { Address } from "@stellar/stellar-sdk";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { walletAddressFromEmail } from "@/lib/wallet-address";
import { CONTRACT_ID, NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import {
  DOQTRI_RELAYER,
  FEE_FORWARDER,
  MAX_USER_FEE_STROOPS,
  NATIVE_XLM,
  NETWORK,
  SHARED_DEPLOYER_SEED,
  USER_PAYS_FEES,
  SMART_ACCOUNT_WASM_HASH,
  THRESHOLD_POLICY,
  WEBAUTHN_VERIFIER,
} from "@/lib/stellar/smart-wallet-config";
import {
  deployedContractAddress,
  deployerAddress,
  parseRelayBody,
  RelayRejection,
  validateForwardedWrite,
  validateRegistryWrite,
  validateWalletAdmin,
  validateWalletDeploy,
  type RelaySubmission,
} from "@/lib/stellar/relay-validation";
import { simulateWithinCap, submitAndConfirm } from "@/lib/stellar/channels";
import { readWalletPasskeys } from "@/lib/stellar/wallet-signers";
import { submitPaidWrite } from "@/lib/stellar/direct-submit";

/**
 * Fee-sponsored submission for passkey smart wallets (progress/002).
 *
 * smart-account-kit's RelayerClient posts `{ func, auth }` here and expects
 * `{ success, data: { transactionId, hash, status } }` or `{ success: false,
 * error }`. Every request spends Doqtri's Channels allowance, so it must come
 * from a signed-in email account, pass the shape checks in relay-validation,
 * fit the per-user and global quota, and simulate under the fee cap.
 *
 * Three kinds of submission: a wallet deployment; a DoqtriRegistry write
 * signed by the caller's own wallet for one of the caller's own notes; and a
 * passkey change (add or remove) on the caller's own wallet. Each relayed
 * registry write is indexed in chain_writes, because Horizon cannot list a
 * contract account's writes by owner.
 */

const DEPLOYS_PER_USER = positive(process.env.CHAIN_DEPLOYS_PER_USER_DAILY, 3);
const DEPLOYS_GLOBAL = positive(process.env.CHAIN_DEPLOYS_GLOBAL_DAILY, 200);
const WRITES_PER_USER = positive(process.env.CHAIN_WRITES_PER_USER_DAILY, 100);
const WRITES_GLOBAL = positive(process.env.CHAIN_WRITES_GLOBAL_DAILY, 5000);
/** Well under the contract's own cap of 15 signers per rule. */
const MAX_PASSKEYS = 10;

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
    const target =
      submission.func.switch().name === "hostFunctionTypeInvokeContract"
        ? Address.fromScAddress(submission.func.invokeContract().contractAddress()).toString()
        : null;
    if (target === CONTRACT_ID) {
      // Where users pay their own fees, an unwrapped write would skip paying.
      if (USER_PAYS_FEES) return fail("Registry writes must go through the fee forwarder.", 403);
      return await relayRegistryWrite(user.id, submission);
    }
    if (USER_PAYS_FEES && target === FEE_FORWARDER) return await relayPaidWrite(user.id, submission);
    return await relayWalletAdmin(user.id, submission, new URL(request.url).hostname);
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

/**
 * A registry write the user's wallet pays for (progress/003): validated like a
 * direct write, then priced and submitted by Doqtri's relayer straight to RPC.
 * Channels is not involved.
 */
async function relayPaidWrite(userId: string, submission: RelaySubmission) {
  const admin = createSupabaseAdminClient();
  const { data: wallet } = await admin
    .from("smart_wallets")
    .select("address")
    .eq("user_id", userId)
    .eq("network", NETWORK)
    .maybeSingle();
  if (!wallet) return fail("Create your passkey wallet first.", 409);

  const write = validateForwardedWrite(submission, {
    forwarder: FEE_FORWARDER!,
    xlm: NATIVE_XLM,
    registry: CONTRACT_ID,
    wallet: wallet.address,
    relayer: DOQTRI_RELAYER!,
    maxFeeCap: MAX_USER_FEE_STROOPS,
  });

  const { data: doc } = await admin
    .from("documents")
    .select("id")
    .eq("id", write.docId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!doc) return fail("That note isn't in your vault.", 403);

  // Still rate-limited: the user pays the fee, but each request costs our
  // relayer a submission and RPC calls.
  const refused = await chargeQuota(userId, "write", WRITES_PER_USER, WRITES_GLOBAL);
  if (refused) return refused;

  const walletEntry = submission.auth.find(
    (entry) => entry.credentials().switch().name !== "sorobanCredentialsSourceAccount" &&
      Address.fromScAddress(
        entry.credentials().switch().name === "sorobanCredentialsAddress"
          ? entry.credentials().address().address()
          : entry.credentials().addressV2().address(),
      ).toString() === wallet.address,
  )!;
  const { hash, feeStroops } = await submitPaidWrite(submission.func, walletEntry, write.maxFee);

  const { error } = await admin.from("chain_writes").insert({
    network: NETWORK,
    tx_hash: hash,
    document_id: write.docId,
    fn: write.fn,
    owner: wallet.address,
  });
  if (error) console.error(`[chain/relay] ${write.fn} ${hash} not indexed: ${error.message}`);

  return Response.json({ success: true, data: { hash, status: "confirmed", feeStroops: feeStroops.toString() } });
}

/**
 * Adds or removes a passkey on the caller's wallet. The wallet contract makes
 * an existing passkey approve the change; this checks the ledger so the last
 * passkey can never be removed, then keeps wallet_passkeys in step.
 */
async function relayWalletAdmin(userId: string, submission: RelaySubmission, rpId: string) {
  const admin = createSupabaseAdminClient();
  const { data: wallet } = await admin
    .from("smart_wallets")
    .select("address")
    .eq("user_id", userId)
    .eq("network", NETWORK)
    .maybeSingle();
  if (!wallet) return fail("Create your passkey wallet first.", 409);

  const change = validateWalletAdmin(submission, { wallet: wallet.address, webauthnVerifier: WEBAUTHN_VERIFIER });
  const onChain = await readWalletPasskeys(wallet.address);

  let removed: Buffer | null = null;
  if (change.fn === "add_signer") {
    if (onChain.some((p) => p.credentialId.equals(change.credentialId))) {
      return fail("That passkey is already on your wallet.", 409);
    }
    if (onChain.length >= MAX_PASSKEYS) return fail(`A wallet can have at most ${MAX_PASSKEYS} passkeys.`, 409);
  } else {
    const target = onChain.find((p) => p.signerId === change.signerId);
    if (!target) return fail("That passkey isn't on your wallet.", 404);
    if (onChain.length <= 1) return fail("You can't remove your only passkey.", 409);
    removed = target.credentialId;
  }

  const refused = await chargeQuota(userId, "write", WRITES_PER_USER, WRITES_GLOBAL);
  if (refused) return refused;

  await simulateWithinCap(submission.func, submission.auth);
  const sent = await submitAndConfirm(submission.func, submission.auth);

  if (change.fn === "add_signer") {
    const { error } = await admin.from("wallet_passkeys").insert({
      credential_id: change.credentialId.toString("base64url"),
      user_id: userId,
      network: NETWORK,
      public_key: `\\x${change.publicKey.toString("hex")}`,
      rp_id: rpId,
    });
    if (error) console.error(`[chain/relay] passkey added to ${wallet.address} (${sent.hash}) but not recorded: ${error.message}`);
  } else if (removed) {
    const { error } = await admin
      .from("wallet_passkeys")
      .delete()
      .eq("network", NETWORK)
      .eq("user_id", userId)
      .eq("credential_id", removed.toString("base64url"));
    if (error) console.error(`[chain/relay] passkey removed from ${wallet.address} (${sent.hash}) but row kept: ${error.message}`);
  }

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
