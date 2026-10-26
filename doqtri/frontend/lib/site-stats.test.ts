import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { averageFeeXlm, fetchInvocations, loadSiteStats, measureFee, resetFeeCache, statsContracts } from "./site-stats";

const HASH = (n: number) => n.toString(16).padStart(64, "0");

function fakeAdmin(users: number, documents: number, writes: string[] = []) {
  return {
    auth: { admin: { listUsers: async () => ({ data: { users: [], total: users }, error: null }) } },
    from: (table: string) => ({
      select: () =>
        table === "chain_writes"
          ? { eq: () => ({ order: () => ({ limit: async () => ({ data: writes.map((tx_hash) => ({ tx_hash })), error: null }) }) }) }
          : Promise.resolve({ count: documents, error: null }),
    }),
  } as unknown as SupabaseClient;
}

/** stellar.expert contract summaries by id, and Horizon fees (stroops) by tx hash. */
const network = (byId: Record<string, number | "fail">, fees: Record<string, number> = {}) =>
  (async (url: string) => {
    const last = String(url).split("/").pop()!;
    if (String(url).includes("/transactions/")) {
      return last in fees ? Response.json({ hash: last, fee_charged: String(fees[last]) }) : new Response("", { status: 404 });
    }
    const n = byId[last];
    if (n === undefined || n === "fail") return new Response("nope", { status: 500 });
    return Response.json({ contract: last, invocations: n });
  }) as unknown as typeof fetch;

beforeEach(() => resetFeeCache());

describe("site stats", () => {
  it("sums invocations across every Doqtri contract", async () => {
    const ids = statsContracts().map((c) => c.id);
    const counts = Object.fromEntries(ids.map((id, i) => [id, (i + 1) * 100]));
    const stats = await loadSiteStats(fakeAdmin(42, 99), network(counts));
    expect(stats.users).toBe(42);
    expect(stats.documents).toBe(99);
    expect(stats.transactions).toBe(ids.reduce((s, _, i) => s + (i + 1) * 100, 0));
    expect(stats.contracts[0].url).toContain(`/contract/${ids[0]}`);
    expect(stats.fee).toBeNull();
  });

  it("counts an unreadable contract as zero but fails when none can be read", async () => {
    const [first, ...rest] = statsContracts().map((c) => c.id);
    const partial = await loadSiteStats(fakeAdmin(1, 1), network({ [first]: 7, ...Object.fromEntries(rest.map((id) => [id, "fail"])) }));
    expect(partial.transactions).toBe(7);
    await expect(loadSiteStats(fakeAdmin(1, 1), network({}))).rejects.toThrow(/stellar\.expert/);
  });

  it("returns null when the response has no invocation count", async () => {
    const f = (async () => Response.json({ contract: "x" })) as unknown as typeof fetch;
    expect(await fetchInvocations("x", f)).toBeNull();
  });
});

describe("measured fee", () => {
  it("averages fee_charged in XLM, skipping writes Horizon cannot find", async () => {
    const writes = [HASH(1), HASH(2), HASH(3)];
    const sample = await measureFee(fakeAdmin(0, 0, writes), network({}, { [HASH(1)]: 500_000, [HASH(2)]: 1_500_000 }));
    expect(sample?.sample).toBe(2);
    expect(sample?.avgXlm).toBeCloseTo(0.1, 10);
  });

  it("is null when there are no writes to measure", async () => {
    expect(await measureFee(fakeAdmin(0, 0, []), network({}))).toBeNull();
    expect(averageFeeXlm([NaN, 0])).toBeNull();
  });

  it("reaches the stats and is reused instead of re-measured", async () => {
    const id = statsContracts()[0].id;
    const first = await loadSiteStats(fakeAdmin(1, 1, [HASH(1)]), network({ [id]: 1 }, { [HASH(1)]: 1_000_000 }));
    expect(first.fee?.avgXlm).toBeCloseTo(0.1, 10);
    // A later request whose Horizon would report a different fee still gets the cached sample.
    const second = await loadSiteStats(fakeAdmin(1, 1, [HASH(1)]), network({ [id]: 1 }, { [HASH(1)]: 9_000_000 }));
    expect(second.fee?.avgXlm).toBeCloseTo(0.1, 10);
  });
});
