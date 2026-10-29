import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTRACT_ID,
  HORIZON_URL,
  LEGACY_CONTRACT_IDS,
  MARKET_CONTRACT_ID,
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
  /** Average fee actually charged on recent anchor writes; null until one can be read. */
  fee: FeeSample | null;
  updatedAt: string;
};

export type FeeSample = { avgXlm: number; sample: number; measuredAt: string };

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

/**
 * Measures what Doqtri's document writes really cost: the latest relayed
 * writes indexed in chain_writes, each fee read back from Horizon, so the
 * number is the network's, not an estimate.
 */
export async function measureFee(admin: SupabaseClient, fetchImpl: typeof fetch = fetch): Promise<FeeSample | null> {
  const { data, error } = await admin
    .from("chain_writes")
    .select("tx_hash")
    .eq("network", NETWORK)
    .order("created_at", { ascending: false })
    .limit(FEE_SAMPLE);
  if (error) throw new Error(`chain_writes: ${error.message}`);

  const hashes = (data ?? []).map((row) => row.tx_hash as string);
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
  return { avgXlm, sample: fees.filter((n) => Number.isFinite(n) && n > 0).length, measuredAt: new Date().toISOString() };
}

/** The cached fee sample, re-measured once it is older than FEE_TTL_MS. A failed re-measure keeps the last one. */
async function cachedFee(admin: SupabaseClient, fetchImpl: typeof fetch, now = Date.now()): Promise<FeeSample | null> {
  if (feeCache && now - feeCache.at < FEE_TTL_MS) return feeCache.value;
  try {
    const value = await measureFee(admin, fetchImpl);
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

export async function loadSiteStats(admin: SupabaseClient, fetchImpl: typeof fetch = fetch): Promise<SiteStats> {
  const contracts = statsContracts();
  const [fee, users, documents, ...invocations] = await Promise.all([
    cachedFee(admin, fetchImpl),
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
