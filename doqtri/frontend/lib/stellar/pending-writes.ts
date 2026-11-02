/**
 * Settles pending paid writes (server-only, WP-4.1, DOQ-5).
 *
 * The relay polls a paid write for about 20 s once the network accepts it.
 * One not confirmed by then is answered 202 and indexed in chain_writes as
 * pending (app/api/chain/relay/route.ts), because it can still land. Each
 * run of the chain-jobs queue (/api/chain/jobs, every minute from pg_cron)
 * asks the ledger about every pending row of this deployment's network:
 *
 *   SUCCESS     confirmed: the note's history reads it like any other write
 *   FAILED      failed: it reached the ledger and changed nothing
 *   NOT_FOUND   still pending while it could land; failed once its time
 *               bound has certainly passed
 *
 * A paid write is built with a 60 s time bound before it is polled, and its
 * row is written after the poll, so the bound ended before created_at + 60 s.
 * PENDING_WRITE_EXPIRY_MS waits ten minutes instead, so clock skew and a
 * slow run never fail a write that could still land. A lookup that errors
 * leaves the row for the next run.
 *
 * The RPC keeps transactions for a limited window only, so a NOT_FOUND from
 * it is checked against Horizon, which keeps them all, before a row is
 * failed: a run that comes back after a long outage still confirms a write
 * that landed in the meantime.
 *
 * Rows pile up exactly when the network is slow, which is also when lookups
 * are slow, and the jobs route has 300 s for everything. So each lookup has
 * a timeout, and a run starts no new lookup once PENDING_WRITES_BUDGET_MS
 * has gone by: what is left waits for the next run, a minute later.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { rpc } from "@stellar/stellar-sdk";
import { HORIZON_URL, RPC_URL } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";

/** How long after its row was written a write not found anywhere is taken as failed. */
export const PENDING_WRITE_EXPIRY_MS = 10 * 60_000;

/** How many pending rows one run reads. */
const PENDING_WRITES_PER_RUN = 25;

/**
 * After this long a run starts no new lookup. One already started still ends
 * within two LOOKUP_TIMEOUT_MS (the RPC, then Horizon).
 */
export const PENDING_WRITES_BUDGET_MS = 60_000;

/** The longest one RPC or Horizon request of a lookup may take. */
const LOOKUP_TIMEOUT_MS = 8_000;

/** A pending row, as chain_writes holds it. */
export type PendingWrite = { tx_hash: string; created_at: string };

/** What the ledger says about a transaction. */
export type LedgerStatus = "SUCCESS" | "FAILED" | "NOT_FOUND";

/** The database side; Supabase in production, an in-memory store in tests. */
export type PendingWriteStore = {
  /** This network's pending rows, oldest first. */
  pending(limit: number): Promise<PendingWrite[]>;
  /** Settles a row that is still pending; false when it no longer was. */
  settle(txHash: string, status: "confirmed" | "failed"): Promise<boolean>;
};

export type PendingWriteSummary = { confirmed: number; failed: number; pending: number };

/**
 * Asks the ledger about each pending write and settles the ones it can.
 * Never throws for a single write: a failed lookup leaves it pending. Once
 * `budgetMs` has gone by the rest are left pending for the next run.
 */
export async function reconcilePendingWrites(
  store: PendingWriteStore,
  lookup: (txHash: string) => Promise<LedgerStatus>,
  {
    now = () => Date.now(),
    limit = PENDING_WRITES_PER_RUN,
    budgetMs = PENDING_WRITES_BUDGET_MS,
  }: { now?: () => number; limit?: number; budgetMs?: number } = {},
): Promise<PendingWriteSummary> {
  const summary: PendingWriteSummary = { confirmed: 0, failed: 0, pending: 0 };
  const startedAt = now();
  for (const write of await store.pending(limit)) {
    if (now() - startedAt >= budgetMs) {
      summary.pending++;
      continue;
    }
    const outcome = await settleOne(write, lookup, now());
    if (outcome === "pending" || !(await store.settle(write.tx_hash, outcome))) {
      summary.pending++;
      continue;
    }
    if (outcome === "failed") console.warn(`[pending-writes] paid write ${write.tx_hash} failed`);
    summary[outcome]++;
  }
  return summary;
}

async function settleOne(
  write: PendingWrite,
  lookup: (txHash: string) => Promise<LedgerStatus>,
  now: number,
): Promise<"confirmed" | "failed" | "pending"> {
  let status: LedgerStatus;
  try {
    status = await lookup(write.tx_hash);
  } catch (error) {
    console.error(`[pending-writes] could not look up ${write.tx_hash}: ${(error as Error).message}`);
    return "pending";
  }
  if (status === "SUCCESS") return "confirmed";
  if (status === "FAILED") return "failed";
  return expired(write, now) ? "failed" : "pending";
}

/** Whether a write's time bound has certainly passed, with room for skew. */
function expired(write: PendingWrite, now: number): boolean {
  const createdAt = Date.parse(write.created_at);
  return Number.isFinite(createdAt) && now - createdAt > PENDING_WRITE_EXPIRY_MS;
}

/** chain_writes through the service role, for one network. */
export function supabasePendingWriteStore(admin: SupabaseClient, network: string): PendingWriteStore {
  return {
    async pending(limit) {
      const { data, error } = await admin
        .from("chain_writes")
        .select("tx_hash, created_at")
        .eq("network", network)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`reading pending writes failed: ${error.message}`);
      return (data ?? []) as PendingWrite[];
    },
    async settle(txHash, status) {
      // Only while still pending, so two overlapping runs settle a row once.
      const { data, error } = await admin
        .from("chain_writes")
        .update({ status })
        .eq("network", network)
        .eq("tx_hash", txHash)
        .eq("status", "pending")
        .select("tx_hash");
      if (error) {
        console.error(`[pending-writes] could not settle ${txHash}: ${error.message}`);
        return false;
      }
      return Boolean(data?.length);
    },
  };
}

/**
 * The RPC's getTransaction, with a NOT_FOUND checked against Horizon, whose
 * history has no retention window. Each request gives up after `timeoutMs`.
 * `server` and `fetchImpl` stand in for the network in tests.
 */
export function ledgerLookup(
  server: Pick<rpc.Server, "getTransaction"> = new rpc.Server(RPC_URL),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): (txHash: string) => Promise<LedgerStatus> {
  return async (txHash) => {
    const result = await withTimeout(server.getTransaction(txHash), timeoutMs, "the RPC");
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return "SUCCESS";
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) return "FAILED";
    const res = await fetchImpl(`${HORIZON_URL}/transactions/${txHash}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return "NOT_FOUND";
    if (!res.ok) throw new Error(`Horizon answered ${res.status}`);
    return ((await res.json()) as { successful?: boolean }).successful ? "SUCCESS" : "FAILED";
  };
}

/** `promise`, or a rejection once `ms` have passed; the RPC client takes no abort signal. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} didn't answer within ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One reconciliation with this deployment's network, RPC and Horizon. `admin`
 * is the service-role client. Async, so that even setting up the RPC client
 * fails as a rejection the jobs route catches.
 */
export async function runPendingWrites(admin: SupabaseClient): Promise<PendingWriteSummary> {
  return reconcilePendingWrites(supabasePendingWriteStore(admin, NETWORK), ledgerLookup());
}
