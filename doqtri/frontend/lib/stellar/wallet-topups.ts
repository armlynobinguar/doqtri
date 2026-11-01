/**
 * Retries of a new smart wallet's first Friendbot top-up (server-only,
 * DOQ-6, WP-4.1). Testnet only.
 *
 * Where wallets pay their own fees, the relay tops a new passkey wallet up
 * while it deploys (friendbot-topup.ts). Friendbot is often busy, and when it
 * refused the wallet stayed empty: its first paid write failed with 402 until
 * the user found Top up themselves. Now a failed first try is queued in
 * wallet_topups (backend/migrations/20261101120000_wallet_topups.sql), and
 * GET /api/chain/jobs, which pg_cron runs every minute beside the chain jobs
 * (chain-jobs.ts), retries it with the same backoff until it lands or
 * MAX_TOPUP_RETRIES is reached; then it is marked failed and logged once.
 *
 * Its own table, not a chain-jobs kind: workspace_chain_jobs is per
 * workspace, admins see it, and its run does nothing with REGISTRY_EDITORS
 * off. A top-up belongs to a wallet and must run regardless.
 *
 * On mainnet nothing is queued or claimed (there is no Friendbot), and the
 * table only accepts testnet rows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { IS_MAINNET } from "@/lib/stellar/config";
import { retryDelayMs } from "@/lib/stellar/chain-jobs";
import { TOP_UP_BELOW_STROOPS, topUpWallet } from "@/lib/stellar/friendbot-topup";
import { xlmBalanceStroops } from "@/lib/stellar/wallet-balance";

/** Retries after the relay's first try: about an hour of backoff (30s, 1m, … 32m). */
export const MAX_TOPUP_RETRIES = 8;

/**
 * Per run. Each try takes up to ~30s (Friendbot, then a transfer and its
 * confirmation) and runs one after another, so a run stays well inside the
 * two-minute lease claim_wallet_topups() takes.
 */
const TOPUPS_PER_RUN = 3;

export type NewWallet = { userId: string; address: string };

export type WalletTopUp = {
  id: string;
  user_id: string;
  address: string;
  /** Retries claimed so far, this one included. */
  attempts: number;
  /** Set by the claim; the row is finished only while it still holds it. */
  claim_token: string | null;
};

export type TopUpUpdate = {
  status: "pending" | "done" | "failed";
  tx_hash?: string | null;
  last_error?: string | null;
  /** When a pending retry may be tried again. */
  next_attempt_at?: string;
};

/** The database side of the queue; Supabase in production, an in-memory store in tests. */
export type WalletTopUpStore = {
  /** Queues a retry; one already open for the wallet counts as queued. */
  enqueue(wallet: NewWallet, error: string): Promise<void>;
  claim(limit: number): Promise<WalletTopUp[]>;
  /** Records a claimed retry's outcome and releases the claim. False when a later run holds it. */
  finish(item: WalletTopUp, update: TopUpUpdate): Promise<boolean>;
};

export type TopUpDeps = {
  mainnet: boolean;
  topUp(address: string): Promise<{ hash: string }>;
  /** The wallet's XLM, in stroops. */
  balance(address: string): Promise<bigint>;
  now?: () => Date;
};

export type TopUpSummary = { skipped: boolean; done: number; pending: number; failed: number };

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * The relay's first top-up of a wallet it is deploying. When it fails, a
 * retry is queued once the deploy lands; a deploy that fails leaves no
 * wallet to fill. Never throws: the relay runs it in after().
 */
export async function topUpNewWallet(
  wallet: NewWallet,
  deployed: Promise<unknown>,
  store: Pick<WalletTopUpStore, "enqueue">,
  deps: Pick<TopUpDeps, "mainnet" | "topUp">,
): Promise<void> {
  if (deps.mainnet) return;
  let error: string;
  try {
    await deps.topUp(wallet.address);
    return;
  } catch (e) {
    error = message(e);
  }
  try {
    await deployed;
  } catch {
    console.error(`[wallet-topups] first top-up for ${wallet.address} failed (${error}); the deploy failed too, so no retry is queued`);
    return;
  }
  try {
    await store.enqueue(wallet, error);
    console.warn(`[wallet-topups] first top-up for ${wallet.address} failed (${error}); retry queued`);
  } catch (e) {
    console.error(`[wallet-topups] first top-up for ${wallet.address} failed (${error}) and no retry could be queued: ${message(e)}`);
  }
}

/**
 * Claims the retries that are due and tries each once. Never throws for a
 * single retry: its outcome is written back and the next one runs.
 */
export async function processWalletTopUps(
  store: WalletTopUpStore,
  deps: TopUpDeps,
  { limit = TOPUPS_PER_RUN }: { limit?: number } = {},
): Promise<TopUpSummary> {
  const summary: TopUpSummary = { skipped: false, done: 0, pending: 0, failed: 0 };
  if (deps.mainnet) return { ...summary, skipped: true };
  const now = deps.now ?? (() => new Date());

  for (const item of await store.claim(limit)) {
    const update = await retry(item, deps, now());
    // A retry a later run holds stays pending for it, and is logged by it.
    if (!(await store.finish(item, update))) {
      summary.pending++;
      continue;
    }
    if (update.status === "failed") {
      console.warn(`[wallet-topups] gave up topping up ${item.address} after ${item.attempts} retries: ${update.last_error ?? ""}`);
    }
    summary[update.status]++;
  }
  return summary;
}

async function retry(item: WalletTopUp, deps: TopUpDeps, now: Date): Promise<TopUpUpdate> {
  try {
    // A first try that timed out may have landed after all, and the user may
    // have used Top up since: a wallet that has plenty is done.
    if ((await deps.balance(item.address)) >= TOP_UP_BELOW_STROOPS) return { status: "done", last_error: null };
    const { hash } = await deps.topUp(item.address);
    return { status: "done", tx_hash: hash, last_error: null };
  } catch (error) {
    const last_error = message(error);
    if (item.attempts >= MAX_TOPUP_RETRIES) return { status: "failed", last_error };
    return { status: "pending", last_error, next_attempt_at: new Date(now.getTime() + retryDelayMs(item.attempts)).toISOString() };
  }
}

/** The queue in doqtri's database, through the service role. */
export function supabaseWalletTopUpStore(admin: SupabaseClient): WalletTopUpStore {
  return {
    async enqueue(wallet, error) {
      const { error: insertError } = await admin
        .from("wallet_topups")
        .insert({ user_id: wallet.userId, address: wallet.address, last_error: error });
      // 23505: a retry is already open for this wallet (wallet_topups_open_idx).
      if (insertError && insertError.code !== "23505") throw new Error(insertError.message);
    },
    async claim(limit) {
      const { data, error } = await admin.rpc("claim_wallet_topups", { p_limit: limit });
      if (error) throw new Error(`claiming wallet top-ups failed: ${error.message}`);
      return (data ?? []) as WalletTopUp[];
    },
    async finish(item, update) {
      if (!item.claim_token) {
        console.error(`[wallet-topups] retry ${item.id} came back from the claim without a token; left for its next run`);
        return false;
      }
      const { data, error } = await admin
        .from("wallet_topups")
        .update({ ...update, claim_token: null })
        .eq("id", item.id)
        .eq("claim_token", item.claim_token)
        .select("id");
      if (error) {
        console.error(`[wallet-topups] could not record retry ${item.id}: ${error.message}`);
        return false;
      }
      return Boolean(data?.length);
    },
  };
}

/** This deployment's top-up deps: Friendbot and RPC, off on mainnet. */
const liveDeps: TopUpDeps = { mainnet: IS_MAINNET, topUp: topUpWallet, balance: xlmBalanceStroops };

/** The relay's first top-up, queued for retry on failure. `admin` is the service-role client. */
export function topUpNewWalletOrQueue(admin: SupabaseClient, wallet: NewWallet, deployed: Promise<unknown>): Promise<void> {
  return topUpNewWallet(wallet, deployed, supabaseWalletTopUpStore(admin), liveDeps);
}

/** One run of the retry queue with this deployment's configuration. `admin` is the service-role client. */
export function runWalletTopUps(admin: SupabaseClient, options: { limit?: number } = {}): Promise<TopUpSummary> {
  return processWalletTopUps(supabaseWalletTopUpStore(admin), liveDeps, options);
}
