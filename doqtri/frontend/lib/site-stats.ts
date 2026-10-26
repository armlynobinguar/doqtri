import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTRACT_ID,
  LEGACY_CONTRACT_IDS,
  MARKET_CONTRACT_ID,
  expertApiContractUrl,
  expertContractUrl,
} from "@/lib/stellar/config";

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
  updatedAt: string;
};

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

export async function loadSiteStats(admin: SupabaseClient, fetchImpl: typeof fetch = fetch): Promise<SiteStats> {
  const contracts = statsContracts();
  const [users, documents, ...invocations] = await Promise.all([
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
    updatedAt: new Date().toISOString(),
  };
}
