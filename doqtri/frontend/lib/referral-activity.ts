/**
 * Counts referred users' on-chain activity and marks referrals eligible
 * (server-only, WP-4.6, DOQ-23, D-109, D-110).
 *
 * An activity is a successful call to a Doqtri contract (statsContracts()) by
 * a wallet of the referred user, at or after the referral was recorded. No
 * existing record holds them all, and testnet resets, so they are stored
 * (backend/migrations/20261107100000_referral_eligibility.sql), from two feeds:
 *
 *   passkey wallets (C…)  Horizon has no feed for a contract address, so the
 *                         relay records each confirmed write on its four write
 *                         paths (recordReferralActivity). A pending note write
 *                         counts once the chain-jobs run has confirmed it: the
 *                         settle step below sweeps chain_writes, which also
 *                         repairs a recording that failed.
 *   wallet logins (G…)    sign and submit themselves, so the database never
 *                         sees those writes. Each run of the chain-jobs queue
 *                         reads the wallet's newest operations from Horizon and
 *                         records the ones that count (runReferralSync).
 *
 * The sync covers referred users without a reward, least recently synced
 * first, a fixed number per run and each at most once per
 * REFERRAL_RESYNC_SECONDS, so Horizon load stays small. It keeps no cursor:
 * reading newest-first needs no state, so a testnet reset can't strand it. A
 * Horizon failure leaves that user's counts alone until their next turn.
 *
 * A paid membership or market write the relay answered 502 for can still land.
 * Nothing records it, so it goes uncounted: an undercount, never a reward
 * nobody earned.
 *
 * Each step is idempotent: an activity is keyed by network and transaction,
 * and the database decides when a referral qualifies.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { logError } from "@/lib/log-error";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import { statsContracts } from "@/lib/site-stats";
import { HORIZON_URL } from "@/lib/stellar/config";
import type { HorizonOperation } from "@/lib/stellar/history";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";

/** How many referred users one run syncs. */
const REFERRAL_SYNCS_PER_RUN = 25;

/**
 * After this long a run starts no new user. One already started still ends
 * within REFERRAL_SYNC_TIMEOUT_MS of Horizon, plus its database calls.
 */
export const REFERRAL_SYNC_BUDGET_MS = 60_000;

/** The longest one wallet's Horizon read may take, all its pages together. */
const REFERRAL_SYNC_TIMEOUT_MS = 8_000;

/** Horizon's largest page, and how many a read follows through a busy wallet's feed. */
const REFERRAL_SYNC_PAGE_SIZE = 200;
const REFERRAL_SYNC_MAX_PAGES = 3;

/** A referred user who was just synced waits this long for their next turn. */
const REFERRAL_RESYNC_SECONDS = 15 * 60;

/** How Horizon names a call to a contract; deployments carry `parameters` too. */
const INVOKE_CONTRACT = "HostFunctionTypeHostFunctionTypeInvokeContract";

/** An operation of a wallet's feed: what history.ts reads, and which host function it ran. */
type FeedOperation = HorizonOperation & { function?: string };

/** The rules, passed to every SQL function that qualifies, which never repeats them. */
const RULES = {
  p_threshold: REFERRAL_ACTIVITY_THRESHOLD,
  p_reward_php: REFERRAL_REWARD_PHP,
  p_default_limit: REFERRAL_REWARD_LIMIT,
};

/** One call that counts, as the database stores it. */
export type ReferralActivity = { txHash: string; wallet: string; fn: string; occurredAt: string };

/** A referred user without a reward, from referral_sync_candidates(). */
export type ReferralCandidate = {
  user_id: string;
  referred_at: string;
  c_wallet: string | null;
  g_wallet: string | null;
};

export type ReferralSyncSummary = { synced: number; failed: number; skipped: number };

/** The database side; Supabase in production, an in-memory store in tests. */
export type ReferralActivityStore = {
  /** Referred users without a reward, least recently synced first. */
  candidates(limit: number): Promise<ReferralCandidate[]>;
  /** Records one activity for a user, and qualifies them if it was the one. */
  record(userId: string, activity: ReferralActivity): Promise<void>;
  /** Sweeps the user's confirmed chain_writes, qualifies them, stamps the sync. */
  settle(userId: string): Promise<void>;
};

function recordArgs(userId: string, network: string, activity: ReferralActivity) {
  return {
    p_user_id: userId,
    p_network: network,
    p_tx_hash: activity.txHash,
    p_wallet: activity.wallet,
    p_fn: activity.fn,
    p_occurred_at: activity.occurredAt,
    ...RULES,
  };
}

/**
 * Records a write the relay has seen confirmed. Never throws: the write is
 * on-chain either way and the user's answer must not depend on this. A note
 * write that fails to record is repaired by the next sync's sweep of
 * chain_writes; a membership or market write has no second record, so it is
 * logged and stays uncounted.
 */
export async function recordReferralActivity(
  admin: Pick<SupabaseClient, "rpc">,
  { userId, txHash, wallet, fn }: { userId: string; txHash: string; wallet: string; fn: string },
): Promise<void> {
  try {
    const { error } = await admin.rpc(
      "record_referral_activity",
      recordArgs(userId, NETWORK, { txHash, wallet, fn, occurredAt: new Date().toISOString() }),
    );
    if (error) logError(`[referrals] ${fn} ${txHash} not recorded`, error);
  } catch (error) {
    logError(`[referrals] ${fn} ${txHash} not recorded`, error);
  }
}

function scVal(value: string): xdr.ScVal {
  return xdr.ScVal.fromXDR(value, "base64");
}

/**
 * The activity one Horizon operation of `wallet`'s feed counts as, or null
 * when it doesn't: not a contract call (a deployment is an
 * invoke_host_function too, and its `parameters` are its constructor's), a
 * failed transaction, another account's operation that merely
 * names the wallet, a contract that isn't Doqtri's, older than the referral,
 * or parameters that can't be read, since the feed holds everything the
 * wallet did. The database checks the referral's time again.
 */
export function referralActivityFrom(
  op: FeedOperation,
  { wallet, contracts, referredAt }: { wallet: string; contracts: readonly string[]; referredAt: string },
): ReferralActivity | null {
  if (op.type !== "invoke_host_function" || op.function !== INVOKE_CONTRACT) return null;
  if (op.transaction_successful === false) return null;
  if (op.source_account !== wallet) return null;
  const params = op.parameters;
  if (!params || params.length < 2) return null;
  // Written so an unreadable time on either side counts as nothing.
  if (!(Date.parse(op.created_at) >= Date.parse(referredAt))) return null;
  try {
    if (!contracts.includes(Address.fromScVal(scVal(params[0].value)).toString())) return null;
    const fn = scValToNative(scVal(params[1].value));
    if (typeof fn !== "string") return null;
    return { txHash: op.transaction_hash, wallet, fn, occurredAt: op.created_at };
  } catch {
    return null;
  }
}

/**
 * One wallet's operations from Horizon, newest first and without failed
 * transactions, back to `since` or for REFERRAL_SYNC_MAX_PAGES pages, so a run
 * of newer operations doesn't hide older calls. An account that was never
 * funded has no feed; anything else unexpected throws, dropping the pages
 * already read. `timeoutMs` covers the whole read, so the pages cost a run
 * nothing beyond its time budget. `fetchImpl` stands in for the network in tests.
 */
export function horizonOperations(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = REFERRAL_SYNC_TIMEOUT_MS,
): (account: string, since: string) => Promise<FeedOperation[]> {
  return async (account, since) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const sinceMs = Date.parse(since);
    const ops: FeedOperation[] = [];
    let url: string | undefined =
      `${HORIZON_URL}/accounts/${account}/operations?order=desc&limit=${REFERRAL_SYNC_PAGE_SIZE}&include_failed=false`;
    for (let page = 0; url && page < REFERRAL_SYNC_MAX_PAGES; page++) {
      const res: Response = await fetchImpl(url, { signal });
      if (res.status === 404) break;
      if (!res.ok) throw new Error(`Horizon answered ${res.status}`);
      const body = (await res.json()) as {
        _embedded?: { records?: FeedOperation[] };
        _links?: { next?: { href?: string } };
      };
      const records = body._embedded?.records ?? [];
      ops.push(...records);
      const oldest = records.at(-1);
      url =
        records.length === REFERRAL_SYNC_PAGE_SIZE && oldest && !(Date.parse(oldest.created_at) < sinceMs)
          ? body._links?.next?.href
          : undefined;
    }
    return ops;
  };
}

/** One user's sync; false when any part of it failed, which the next run repeats. */
async function syncOne(
  candidate: ReferralCandidate,
  store: ReferralActivityStore,
  readOperations: (account: string, since: string) => Promise<FeedOperation[]>,
  contracts: readonly string[],
): Promise<boolean> {
  let ok = true;
  const wallet = candidate.g_wallet;
  if (wallet) {
    try {
      for (const op of await readOperations(wallet, candidate.referred_at)) {
        const activity = referralActivityFrom(op, { wallet, contracts, referredAt: candidate.referred_at });
        if (activity) await store.record(candidate.user_id, activity);
      }
    } catch (error) {
      logError(`[referrals] could not sync ${wallet}`, error);
      ok = false;
    }
  }
  // Always, so a Horizon failure neither holds up the sweep nor keeps this
  // user at the front of the queue. It stamps the sync, so their retry waits
  // for their next turn, REFERRAL_RESYNC_SECONDS away.
  try {
    await store.settle(candidate.user_id);
  } catch (error) {
    logError(`[referrals] could not settle ${candidate.user_id}`, error);
    ok = false;
  }
  return ok;
}

/**
 * Syncs the next referred users. Never throws for a single user. Once
 * `budgetMs` has gone by the rest are left for the next run, and their turn
 * stays at the front of the queue.
 */
export async function syncReferralActivity(
  store: ReferralActivityStore,
  readOperations: (account: string, since: string) => Promise<FeedOperation[]>,
  contracts: readonly string[],
  {
    now = () => Date.now(),
    limit = REFERRAL_SYNCS_PER_RUN,
    budgetMs = REFERRAL_SYNC_BUDGET_MS,
  }: { now?: () => number; limit?: number; budgetMs?: number } = {},
): Promise<ReferralSyncSummary> {
  const summary: ReferralSyncSummary = { synced: 0, failed: 0, skipped: 0 };
  const startedAt = now();
  for (const candidate of await store.candidates(limit)) {
    if (now() - startedAt >= budgetMs) {
      summary.skipped++;
      continue;
    }
    if (await syncOne(candidate, store, readOperations, contracts)) summary.synced++;
    else summary.failed++;
  }
  return summary;
}

/** The referral functions through the service role, for one network. */
export function supabaseReferralStore(admin: Pick<SupabaseClient, "rpc">, network: string): ReferralActivityStore {
  return {
    async candidates(limit) {
      const { data, error } = await admin.rpc("referral_sync_candidates", {
        p_network: network,
        p_limit: limit,
        p_min_resync_seconds: REFERRAL_RESYNC_SECONDS,
      });
      if (error) throw new Error(`reading referral candidates failed: ${error.message}`);
      return (data ?? []) as ReferralCandidate[];
    },
    async record(userId, activity) {
      const { error } = await admin.rpc("record_referral_activity", recordArgs(userId, network, activity));
      if (error) throw new Error(`recording ${activity.txHash} failed: ${error.message}`);
    },
    async settle(userId) {
      const { error } = await admin.rpc("settle_referral_activity", { p_user_id: userId, p_network: network, ...RULES });
      if (error) throw new Error(`settling failed: ${error.message}`);
    },
  };
}

/**
 * One sync with this deployment's network and Horizon. `admin` is the
 * service-role client. Async, so that anything thrown while setting up fails
 * as a rejection the jobs route catches.
 */
export async function runReferralSync(admin: Pick<SupabaseClient, "rpc">): Promise<ReferralSyncSummary> {
  return syncReferralActivity(
    supabaseReferralStore(admin, NETWORK),
    horizonOperations(),
    statsContracts().map((contract) => contract.id),
  );
}
