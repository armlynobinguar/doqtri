import { after } from "next/server";
import { Address } from "@stellar/stellar-sdk";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { walletAddressFromEmail } from "@/lib/wallet-address";
import { CONTRACT_ID, IS_MAINNET, MARKET_CONTRACT_ID, NETWORK_PASSPHRASE, REGISTRY_EDITORS } from "@/lib/stellar/config";
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
  authorizeRegistryWrite,
  deployedContractAddress,
  deployerAddress,
  forwardedMarketCallOf,
  forwardedTarget,
  isDocumentWrite,
  marketCallOf,
  parseRelayBody,
  RelayRejection,
  validateForwardedMarketWrite,
  validateForwardedWrite,
  validateMarketWrite,
  validateRegistryWrite,
  validateWalletAdmin,
  validateWalletDeploy,
  type MarketCall,
  type RegistryWrite,
  type RelaySubmission,
} from "@/lib/stellar/relay-validation";
import { registryAccess } from "@/lib/stellar/registry-access";
import { MAX_MARKET_FEE_STROOPS } from "@/lib/stellar/market-config";
import { marketCallPlan, purchaseColumns, syncTemplate, type SaleRecord } from "@/lib/market-server";
import { simulateWithinCap, submitAndConfirm } from "@/lib/stellar/channels";
import { readWalletPasskeys } from "@/lib/stellar/wallet-signers";
import { submitPaidWrite } from "@/lib/stellar/direct-submit";
import { topUpWallet } from "@/lib/stellar/friendbot-topup";

/**
 * Fee-sponsored submission for passkey smart wallets (progress/002).
 *
 * smart-account-kit's RelayerClient posts `{ func, auth }` here and expects
 * `{ success, data: { transactionId, hash, status } }` or `{ success: false,
 * error }`. Every request spends Doqtri's Channels allowance, so it must come
 * from a signed-in email account, pass the shape checks in relay-validation,
 * simulate under the fee cap, and fit the per-user and global quota (charged
 * only once a request has simulated, so a refused one doesn't count).
 *
 * Four kinds of submission: a wallet deployment; a DoqtriRegistry write
 * signed by the caller's own wallet on a note (or, with REGISTRY_EDITORS, a
 * workspace) the caller's current workspace role lets them write; a
 * TemplateMarket write by the caller's wallet on a template Doqtri lists
 * (progress/004); and a passkey change (add or remove) on the caller's own
 * wallet. Each relayed
 * note write is indexed in chain_writes, because Horizon cannot list a
 * contract account's writes by owner.
 */

const DEPLOYS_PER_USER = positive(process.env.CHAIN_DEPLOYS_PER_USER_DAILY, 3);
const DEPLOYS_GLOBAL = positive(process.env.CHAIN_DEPLOYS_GLOBAL_DAILY, 200);
const WRITES_PER_USER = positive(process.env.CHAIN_WRITES_PER_USER_DAILY, 100);
const WRITES_GLOBAL = positive(process.env.CHAIN_WRITES_GLOBAL_DAILY, 5000);
const MARKET_PER_USER = positive(process.env.CHAIN_MARKET_PER_USER_DAILY, 50);
const MARKET_GLOBAL = positive(process.env.CHAIN_MARKET_GLOBAL_DAILY, 2000);
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
    if (MARKET_CONTRACT_ID && target === MARKET_CONTRACT_ID) {
      if (USER_PAYS_FEES) return fail("Market calls must go through the fee forwarder.", 403);
      return await relayMarketWrite(user.id, submission);
    }
    if (target === CONTRACT_ID) {
      // Where users pay their own fees, an unwrapped write would skip paying.
      if (USER_PAYS_FEES) return fail("Registry writes must go through the fee forwarder.", 403);
      return await relayRegistryWrite(user.id, submission);
    }
    if (USER_PAYS_FEES && target === FEE_FORWARDER) {
      if (MARKET_CONTRACT_ID && forwardedTarget(submission.func) === MARKET_CONTRACT_ID) {
        return await relayPaidMarketWrite(user.id, submission);
      }
      return await relayPaidWrite(user.id, submission);
    }
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
  kind: "deploy" | "write" | "market",
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
  await authorizeWrite(userId, write);

  // Simulated before charging: a request refused here spends nothing.
  await simulateWithinCap(submission.func, submission.auth);
  const refused = await chargeQuota(userId, "write", WRITES_PER_USER, WRITES_GLOBAL);
  if (refused) return refused;

  const sent = await submitAndConfirm(submission.func, submission.auth);
  await indexWrite(write, sent.hash, wallet.address);

  return Response.json({ success: true, data: sent });
}

/**
 * The contract checks the signature; this checks, against the database at
 * this moment, that the caller may make this write at all, so nobody spends
 * fees on arbitrary documents or workspaces and a member removed in the app
 * is cut off at once (D-16). The v3 calls are refused until the deployed
 * registry has them (REGISTRY_EDITORS).
 */
async function authorizeWrite(userId: string, write: RegistryWrite): Promise<void> {
  await authorizeRegistryWrite(write, userId, registryAccess(createSupabaseAdminClient()), REGISTRY_EDITORS);
}

/**
 * Note writes go into chain_writes, keyed by the wallet that signed them.
 * The write is on-chain either way; a missing index row only hides it from
 * the history list until reconciled, so report success and log loudly.
 * Membership writes belong to no note and are not indexed.
 */
async function indexWrite(write: RegistryWrite, hash: string, wallet: string): Promise<void> {
  if (!isDocumentWrite(write)) return;
  const { error } = await createSupabaseAdminClient().from("chain_writes").insert({
    network: NETWORK,
    tx_hash: hash,
    document_id: write.docId,
    fn: write.fn,
    owner: wallet,
  });
  if (error) console.error(`[chain/relay] ${write.fn} ${hash} not indexed: ${error.message}`);
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

  await authorizeWrite(userId, write);

  // Still rate-limited: the user pays the fee, but each request costs our
  // relayer a submission and RPC calls.
  const refused = await chargeQuota(userId, "write", WRITES_PER_USER, WRITES_GLOBAL);
  if (refused) return refused;

  const { hash, feeStroops } = await submitPaidWrite(submission.func, walletAuthEntry(submission, wallet.address), write.maxFee);
  await indexWrite(write, hash, wallet.address);

  return Response.json({ success: true, data: { hash, status: "confirmed", feeStroops: feeStroops.toString() } });
}

/** The wallet's own (validated) approval among a submission's auth entries. */
function walletAuthEntry(submission: RelaySubmission, wallet: string) {
  return submission.auth.find(
    (entry) => entry.credentials().switch().name !== "sorobanCredentialsSourceAccount" &&
      Address.fromScAddress(
        entry.credentials().switch().name === "sorobanCredentialsAddress"
          ? entry.credentials().address().address()
          : entry.credentials().addressV2().address(),
      ).toString() === wallet,
  )!;
}

/**
 * The marketplace's equivalent of "the note is the caller's": the relay only
 * pays to submit calls on templates Doqtri lists. A listing must match the
 * draft /api/market/publish prepared for this user; price and listing
 * changes must be on the user's own templates; tips and purchases must be on
 * templates the gallery shows.
 */
async function authorizeMarketCall(userId: string, call: MarketCall): Promise<Response | null> {
  const { data: row } = await createSupabaseAdminClient()
    .from("market_templates")
    .select("creator_id, status, hidden, content_hash, token, price::text, parent_id")
    .eq("id", call.templateId)
    .eq("network", NETWORK)
    .maybeSingle();
  if (!row) return fail("That template isn't in the Doqtri gallery.", 404);

  switch (call.fn) {
    case "list_template":
      if (
        row.creator_id !== userId ||
        row.status !== "pending" ||
        row.content_hash !== call.contentHash ||
        row.token !== call.token ||
        BigInt(row.price) !== call.price ||
        (row.parent_id ?? null) !== call.parent
      ) {
        return fail("This listing doesn't match what you prepared. Publish it again.", 409);
      }
      return null;
    case "update_price":
    case "set_listed":
      return row.creator_id === userId && row.status !== "pending" ? null : fail("That template isn't yours.", 403);
    case "tip":
    case "buy":
      return row.status === "listed" && !row.hidden ? null : fail("That template isn't available.", 409);
  }
}

/**
 * After a market write lands: a buy is recorded so claim and the earnings
 * page can find it; a price or listing change refreshes the gallery's cache.
 */
async function recordPurchase(userId: string, wallet: string, call: MarketCall, sale: SaleRecord | null, hash: string) {
  if (call.fn === "update_price" || call.fn === "set_listed") {
    await syncTemplate(createSupabaseAdminClient(), call.templateId).catch((e: Error) =>
      console.error(`[chain/relay] ${call.templateId} not synced after ${call.fn}: ${e.message}`),
    );
    return;
  }
  if (call.fn !== "buy" || !sale) return;
  const { error } = await createSupabaseAdminClient().from("market_purchases").insert({
    network: NETWORK,
    template_id: call.templateId,
    buyer_id: userId,
    buyer_wallet: wallet,
    tx_hash: hash,
    ...purchaseColumns(sale),
  });
  // On-chain either way; claim re-checks has_purchased, so log and move on.
  if (error) console.error(`[chain/relay] purchase ${hash} not recorded: ${error.message}`);
}

/** A market write paid for by the user's wallet through the FeeForwarder. */
async function relayPaidMarketWrite(userId: string, submission: RelaySubmission) {
  const admin = createSupabaseAdminClient();
  const { data: wallet } = await admin
    .from("smart_wallets")
    .select("address")
    .eq("user_id", userId)
    .eq("network", NETWORK)
    .maybeSingle();
  if (!wallet) return fail("Create your passkey wallet first.", 409);

  const call = forwardedMarketCallOf(submission.func, MARKET_CONTRACT_ID!, wallet.address);
  const refusedCall = await authorizeMarketCall(userId, call);
  if (refusedCall) return refusedCall;

  const plan = await marketCallPlan(call, wallet.address);
  const write = validateForwardedMarketWrite(submission, {
    forwarder: FEE_FORWARDER!,
    xlm: NATIVE_XLM,
    market: MARKET_CONTRACT_ID!,
    wallet: wallet.address,
    relayer: DOQTRI_RELAYER!,
    maxFeeCap: MAX_MARKET_FEE_STROOPS,
    transfers: plan.transfers,
  });

  const refused = await chargeQuota(userId, "market", MARKET_PER_USER, MARKET_GLOBAL);
  if (refused) return refused;

  const { hash, feeStroops } = await submitPaidWrite(submission.func, walletAuthEntry(submission, wallet.address), write.maxFee);
  await recordPurchase(userId, wallet.address, call, plan.sale, hash);
  return Response.json({ success: true, data: { hash, status: "confirmed", feeStroops: feeStroops.toString() } });
}

/** A market write sponsored through Channels, on networks without a forwarder. */
async function relayMarketWrite(userId: string, submission: RelaySubmission) {
  const admin = createSupabaseAdminClient();
  const { data: wallet } = await admin
    .from("smart_wallets")
    .select("address")
    .eq("user_id", userId)
    .eq("network", NETWORK)
    .maybeSingle();
  if (!wallet) return fail("Create your passkey wallet first.", 409);

  const call = marketCallOf(submission.func, MARKET_CONTRACT_ID!, wallet.address);
  const refusedCall = await authorizeMarketCall(userId, call);
  if (refusedCall) return refusedCall;

  const plan = await marketCallPlan(call, wallet.address);
  validateMarketWrite(submission, { market: MARKET_CONTRACT_ID!, wallet: wallet.address, transfers: plan.transfers });

  // Simulated before charging: a request refused here spends nothing.
  await simulateWithinCap(submission.func, submission.auth);
  const refused = await chargeQuota(userId, "market", MARKET_PER_USER, MARKET_GLOBAL);
  if (refused) return refused;

  const sent = await submitAndConfirm(submission.func, submission.auth);
  await recordPurchase(userId, wallet.address, call, plan.sale, sent.hash);
  return Response.json({ success: true, data: sent });
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

  // Simulated before charging: a request refused here spends nothing.
  await simulateWithinCap(submission.func, submission.auth);
  const refused = await chargeQuota(userId, "write", WRITES_PER_USER, WRITES_GLOBAL);
  if (refused) return refused;

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

  // Charged after validation and simulation, so a request that is malformed,
  // would fail on-chain or costs more than the cap spends nothing.
  await simulateWithinCap(submission.func, submission.auth);
  const refused = await chargeQuota(userId, "deploy", DEPLOYS_PER_USER, DEPLOYS_GLOBAL);
  if (refused) return refused;

  // Where wallets pay their own fees, a new wallet can't anchor until it holds
  // test XLM. The address is known before the deploy lands and the native token
  // accepts transfers to it, so the top-up (Friendbot, then a transfer: ~10s)
  // runs alongside the deploy instead of after it, and `after` lets it finish
  // once the response is sent. Best effort: Top up in the app covers a failure.
  const address = deployedContractAddress(deploy.deployer, deploy.salt, NETWORK_PASSPHRASE);
  if (USER_PAYS_FEES && !IS_MAINNET) {
    const topUp = topUpWallet(address).catch((error: Error) =>
      console.error(`[chain/relay] first top-up for ${address} failed: ${error.message}`),
    );
    after(() => topUp);
  }

  const sent = await submitAndConfirm(submission.func, submission.auth);

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
