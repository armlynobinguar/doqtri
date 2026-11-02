import { rpc } from "@stellar/stellar-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTRACT_ID,
  HORIZON_URL,
  LEGACY_CONTRACT_IDS,
  MARKET_CONTRACT_ID,
  RPC_URL,
  expertApiContractUrl,
  expertContractUrl,
} from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";

/**
 * The landing page's live numbers. Sign-ups and documents come from Supabase;
 * on-chain activity comes from stellar.expert's per-contract summary, so it
 * counts every call to Doqtri's contracts, whichever wallet or relay sent it.
 */
export type SiteStats = {
  users: number;
  documents: number;
  transactions: number;
  contracts: { id: string; label: string; invocations: number; url: string }[];
  /** Average fee actually charged on recent contract transactions; null until one can be read. */
  fee: FeeSample | null;
  updatedAt: string;
};

/**
 * `source` says where the measured transactions came from: "contracts" when
 * they were read from the contracts' own events (every wallet), "relay" when
 * that failed and the relay's chain_writes were used instead.
 */
export type FeeSample = { avgXlm: number; sample: number; measuredAt: string; source: "contracts" | "relay" };

/** Every contract Doqtri writes to on this network, current registry first. */
export function statsContracts(): { id: string; label: string }[] {
  return [
    { id: CONTRACT_ID, label: "DoqtriRegistry" },
    ...LEGACY_CONTRACT_IDS.map((id) => ({ id, label: "DoqtriRegistry v1" })),
    ...(MARKET_CONTRACT_ID ? [{ id: MARKET_CONTRACT_ID, label: "TemplateMarket" }] : []),
  ];
}

/** One contract's invocation count; `null` when stellar.expert can't be read. */
export async function fetchInvocations(id: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(expertApiContractUrl(id), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { invocations?: unknown };
    return typeof body.invocations === "number" ? body.invocations : null;
  } catch {
    return null;
  }
}

/** Recent anchor writes whose fees are averaged. */
const FEE_SAMPLE = 40;
const HORIZON_BATCH = 10;
const STROOPS_PER_XLM = 10_000_000;
/** Fees barely move, so the sample is re-measured a few times a day, not per request. */
const FEE_TTL_MS = 6 * 60 * 60 * 1000;

let feeCache: { at: number; value: FeeSample } | null = null;

/** Average of Horizon `fee_charged` (stroops) in XLM; null when there is nothing to average. */
export function averageFeeXlm(stroops: number[]): number | null {
  const valid = stroops.filter((n) => Number.isFinite(n) && n > 0);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length / STROOPS_PER_XLM;
}

/** Latest transactions (newest first) that called the given contracts, at most `limit`. */
export type RecentContractTxs = (contractIds: string[], limit: number) => Promise<string[]>;

/**
 * Ledgers per getEvents request. One request only scans a bounded ledger range
 * (a request starting a week back returns nothing from this week), so the
 * search walks back from the newest ledger in windows small enough to be
 * scanned whole.
 */
const EVENT_WINDOW_LEDGERS = 5_000;
const EVENT_PAGE = 1000;
/** Full pages followed inside one window before moving on. */
const EVENT_MAX_PAGES = 5;
/** Kept clear of the oldest retained ledger, which advances while the search runs. */
const RETENTION_MARGIN = 100;
/** Soroban RPC accepts at most this many contract ids per event filter. */
const IDS_PER_FILTER = 5;

/**
 * The latest successful transactions that called Doqtri's contracts (newest
 * first), read from their events through Soroban RPC as far back as it
 * retains them (about a week on testnet). Unlike chain_writes this includes
 * transactions that Freighter and other wallets submitted themselves, not
 * only the relay's.
 */
export const recentContractTxs: RecentContractTxs = async (contractIds, limit) => {
  if (contractIds.length === 0) return [];
  const server = new rpc.Server(RPC_URL);
  const { latestLedger, oldestLedger } = await server.getHealth();
  const floor = oldestLedger + RETENTION_MARGIN;
  const filters = [];
  for (let i = 0; i < contractIds.length; i += IDS_PER_FILTER) {
    filters.push({ type: "contract" as const, contractIds: contractIds.slice(i, i + IDS_PER_FILTER) });
  }

  const found: string[] = [];
  const seen = new Set<string>();
  let end: number | undefined; // the first window runs to the newest ledger
  let start = Math.max(floor, latestLedger - EVENT_WINDOW_LEDGERS);
  while (found.length < limit) {
    // Events come oldest first within a window.
    const windowHashes: string[] = [];
    let page = await server.getEvents({ filters, startLedger: start, ...(end ? { endLedger: end } : {}), limit: EVENT_PAGE });
    for (let n = 1; ; n++) {
      // Current RPCs emit events of successful calls only and leave the flag out, so only
      // an explicit `false` (older RPCs) marks a failed call.
      for (const event of page.events) if (event.inSuccessfulContractCall !== false) windowHashes.push(event.txHash);
      if (page.events.length < EVENT_PAGE || n >= EVENT_MAX_PAGES) break;
      page = await server.getEvents({ filters, cursor: page.cursor, limit: EVENT_PAGE });
    }
    for (const hash of windowHashes.reverse()) {
      if (!seen.has(hash)) {
        seen.add(hash);
        found.push(hash);
      }
    }
    if (start <= floor) break;
    end = start;
    start = Math.max(floor, start - EVENT_WINDOW_LEDGERS);
  }
  return found.slice(0, limit);
};

/** The relay's latest indexed writes: the fallback when contract events can't be read. */
async function recentRelayTxs(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin
    .from("chain_writes")
    .select("tx_hash")
    .eq("network", NETWORK)
    .order("created_at", { ascending: false })
    .limit(FEE_SAMPLE);
  if (error) throw new Error(`chain_writes: ${error.message}`);
  return (data ?? []).map((row) => row.tx_hash as string);
}

/**
 * Measures what Doqtri's transactions really cost: the latest transactions
 * that called its contracts, from any wallet, each fee read back from Horizon,
 * so the number is the network's, not an estimate. Falls back to the relay's
 * chain_writes when the contract events can't be read.
 */
export async function measureFee(
  admin: SupabaseClient,
  fetchImpl: typeof fetch = fetch,
  recentTxs: RecentContractTxs = recentContractTxs,
): Promise<FeeSample | null> {
  let source: FeeSample["source"] = "contracts";
  let hashes: string[] = [];
  try {
    hashes = await recentTxs(statsContracts().map((c) => c.id), FEE_SAMPLE);
  } catch (e) {
    console.error(`[stats] contract events not read: ${(e as Error).message}`);
  }
  if (hashes.length === 0) {
    source = "relay";
    hashes = await recentRelayTxs(admin);
  }

  const fees: number[] = [];
  for (let i = 0; i < hashes.length; i += HORIZON_BATCH) {
    const batch = await Promise.all(
      hashes.slice(i, i + HORIZON_BATCH).map(async (hash) => {
        try {
          const res = await fetchImpl(`${HORIZON_URL}/transactions/${hash}`, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) return NaN;
          return Number(((await res.json()) as { fee_charged?: unknown }).fee_charged);
        } catch {
          return NaN;
        }
      }),
    );
    fees.push(...batch);
  }

  const avgXlm = averageFeeXlm(fees);
  if (avgXlm === null) return null;
  return {
    avgXlm,
    sample: fees.filter((n) => Number.isFinite(n) && n > 0).length,
    measuredAt: new Date().toISOString(),
    source,
  };
}

/** The cached fee sample, re-measured once it is older than FEE_TTL_MS. A failed re-measure keeps the last one. */
async function cachedFee(
  admin: SupabaseClient,
  fetchImpl: typeof fetch,
  recentTxs: RecentContractTxs,
  now = Date.now(),
): Promise<FeeSample | null> {
  if (feeCache && now - feeCache.at < FEE_TTL_MS) return feeCache.value;
  try {
    const value = await measureFee(admin, fetchImpl, recentTxs);
    if (value) feeCache = { at: now, value };
  } catch (e) {
    console.error(`[stats] fee not measured: ${(e as Error).message}`);
  }
  return feeCache?.value ?? null;
}

/** Test hook: forget the cached fee sample. */
export function resetFeeCache() {
  feeCache = null;
}

export async function loadSiteStats(
  admin: SupabaseClient,
  fetchImpl: typeof fetch = fetch,
  recentTxs: RecentContractTxs = recentContractTxs,
): Promise<SiteStats> {
  const contracts = statsContracts();
  const [fee, users, documents, ...invocations] = await Promise.all([
    cachedFee(admin, fetchImpl, recentTxs),
    // perPage 1: only the total is needed, not the users themselves.
    admin.auth.admin.listUsers({ page: 1, perPage: 1 }).then(({ data, error }) => {
      if (error) throw new Error(`users: ${error.message}`);
      return "total" in data ? data.total : 0;
    }),
    admin
      .from("documents")
      .select("id", { count: "exact", head: true })
      .then(({ count, error }) => {
        if (error) throw new Error(`documents: ${error.message}`);
        return count ?? 0;
      }),
    ...contracts.map((c) => fetchInvocations(c.id, fetchImpl)),
  ]);

  if (invocations.every((n) => n === null)) throw new Error("stellar.expert: no contract could be read");

  return {
    users,
    documents,
    transactions: invocations.reduce<number>((sum, n) => sum + (n ?? 0), 0),
    contracts: contracts.map((c, i) => ({
      ...c,
      invocations: invocations[i] ?? 0,
      url: expertContractUrl(c.id),
    })),
    fee,
    updatedAt: new Date().toISOString(),
  };
}
