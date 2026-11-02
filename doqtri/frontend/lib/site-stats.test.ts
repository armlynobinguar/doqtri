import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  averageFeeXlm,
  fetchInvocations,
  loadSiteStats,
  measureFee,
  recentContractTxs,
  resetFeeCache,
  statsContracts,
  type RecentContractTxs,
} from "./site-stats";

/** No contract events: the fee falls back to the relay's chain_writes. */
const noEvents: RecentContractTxs = async () => [];

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
    const stats = await loadSiteStats(fakeAdmin(42, 99), network(counts), noEvents);
    expect(stats.users).toBe(42);
    expect(stats.documents).toBe(99);
    expect(stats.transactions).toBe(ids.reduce((s, _, i) => s + (i + 1) * 100, 0));
    expect(stats.contracts[0].url).toContain(`/contract/${ids[0]}`);
    expect(stats.fee).toBeNull();
  });

  it("counts an unreadable contract as zero but fails when none can be read", async () => {
    const [first, ...rest] = statsContracts().map((c) => c.id);
    const partial = await loadSiteStats(fakeAdmin(1, 1), network({ [first]: 7, ...Object.fromEntries(rest.map((id) => [id, "fail"])) }), noEvents);
    expect(partial.transactions).toBe(7);
    await expect(loadSiteStats(fakeAdmin(1, 1), network({}), noEvents)).rejects.toThrow(/stellar\.expert/);
  });

  it("returns null when the response has no invocation count", async () => {
    const f = (async () => Response.json({ contract: "x" })) as unknown as typeof fetch;
    expect(await fetchInvocations("x", f)).toBeNull();
  });
});

describe("measured fee", () => {
  it("averages fee_charged in XLM, skipping writes Horizon cannot find", async () => {
    const writes = [HASH(1), HASH(2), HASH(3)];
    const sample = await measureFee(fakeAdmin(0, 0, writes), network({}, { [HASH(1)]: 500_000, [HASH(2)]: 1_500_000 }), noEvents);
    expect(sample?.sample).toBe(2);
    expect(sample?.avgXlm).toBeCloseTo(0.1, 10);
  });

  it("is null when there are no writes to measure", async () => {
    expect(await measureFee(fakeAdmin(0, 0, []), network({}), noEvents)).toBeNull();
    expect(averageFeeXlm([NaN, 0])).toBeNull();
  });

  it("measures every wallet's transactions from the contract events, not only the relay's", async () => {
    const asked: { ids: string[]; limit: number }[] = [];
    const events: RecentContractTxs = async (ids, limit) => {
      asked.push({ ids, limit });
      return [HASH(7), HASH(8)];
    };
    // The relay has one write; the contracts saw two other transactions (e.g. from Freighter).
    const sample = await measureFee(
      fakeAdmin(0, 0, [HASH(1)]),
      network({}, { [HASH(1)]: 9_000_000, [HASH(7)]: 1_000_000, [HASH(8)]: 3_000_000 }),
      events,
    );
    expect(sample).toMatchObject({ sample: 2, source: "contracts" });
    expect(sample?.avgXlm).toBeCloseTo(0.2, 10);
    expect(asked).toEqual([{ ids: statsContracts().map((c) => c.id), limit: 40 }]);
  });

  it("falls back to the relay's writes when the contract events can't be read", async () => {
    const failing: RecentContractTxs = async () => {
      throw new Error("rpc down");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sample = await measureFee(fakeAdmin(0, 0, [HASH(1)]), network({}, { [HASH(1)]: 2_000_000 }), failing);
    expect(sample).toMatchObject({ sample: 1, source: "relay" });
    expect(sample?.avgXlm).toBeCloseTo(0.2, 10);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("rpc down"));
    error.mockRestore();
  });

  it("reaches the stats and is reused instead of re-measured", async () => {
    const id = statsContracts()[0].id;
    const first = await loadSiteStats(fakeAdmin(1, 1, [HASH(1)]), network({ [id]: 1 }, { [HASH(1)]: 1_000_000 }), noEvents);
    expect(first.fee?.avgXlm).toBeCloseTo(0.1, 10);
    // A later request whose Horizon would report a different fee still gets the cached sample.
    const second = await loadSiteStats(fakeAdmin(1, 1, [HASH(1)]), network({ [id]: 1 }, { [HASH(1)]: 9_000_000 }), noEvents);
    expect(second.fee?.avgXlm).toBeCloseTo(0.1, 10);
  });
});

describe("recent contract transactions", () => {
  /**
   * A page of events, oldest first as the RPC returns them: one per [txHash, successful].
   * `undefined` leaves the flag out, as current RPCs do.
   */
  const page = (rows: [string, boolean | undefined][], cursor = "next") =>
    ({
      events: rows.map(([txHash, ok]) => (ok === undefined ? { txHash } : { txHash, inSuccessfulContractCall: ok })),
      cursor,
      latestLedger: 2_000_000,
      oldestLedger: 1_000_000,
    }) as unknown as rpc.Api.GetEventsResponse;
  const health = (oldestLedger: number) =>
    vi.spyOn(rpc.Server.prototype, "getHealth").mockResolvedValue({
      latestLedger: 2_000_000,
      oldestLedger,
      ledgerRetentionWindow: 2_000_000 - oldestLedger,
      status: "healthy",
    });
  const requests = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0] as Record<string, unknown>);

  afterEach(() => vi.restoreAllMocks());

  it("counts events without the success flag, as current RPCs send them", async () => {
    health(1_000_000);
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValueOnce(page([["a", undefined], ["b", undefined]]));
    expect(await recentContractTxs(["C1"], 2)).toEqual(["b", "a"]);
  });

  it("returns the newest successful transactions first, once each", async () => {
    health(1_000_000);
    // tx a emits two events, b failed.
    const getEvents = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce(page([["a", true], ["a", true], ["b", false], ["c", true], ["d", true]]));

    expect(await recentContractTxs(["C1"], 2)).toEqual(["d", "c"]);
    // The first window runs from 5,000 ledgers back to the newest ledger.
    expect(requests(getEvents)).toEqual([
      { filters: [{ type: "contract", contractIds: ["C1"] }], startLedger: 1_995_000, limit: 1000 },
    ]);
  });

  it("walks back one window at a time until it has enough", async () => {
    health(1_000_000);
    const getEvents = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce(page([["x", true]]))
      .mockResolvedValueOnce(page([["v", true], ["w", true], ["x", true]]));

    expect(await recentContractTxs(["C1"], 3)).toEqual(["x", "w", "v"]);
    const [, second] = requests(getEvents);
    expect(second).toMatchObject({ startLedger: 1_990_000, endLedger: 1_995_000 });
  });

  it("stops at the oldest retained ledger with whatever it found", async () => {
    health(1_993_000); // retention ends just past the first window
    const getEvents = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce(page([["b", true]]))
      .mockResolvedValueOnce(page([["a", true]]));

    expect(await recentContractTxs(["C1"], 40)).toEqual(["b", "a"]);
    expect(getEvents).toHaveBeenCalledTimes(2);
    // Kept 100 ledgers clear of the oldest retained one, which moves on while the search runs.
    expect(requests(getEvents)[1]).toMatchObject({ startLedger: 1_993_100, endLedger: 1_995_000 });
  });

  it("follows the cursor through a full page, and splits ids into filters of five", async () => {
    health(1_000_000);
    const full = Array.from({ length: 1000 }, (_, i) => [`t${i}`, true] as [string, boolean | undefined]);
    const getEvents = vi
      .spyOn(rpc.Server.prototype, "getEvents")
      .mockResolvedValueOnce(page(full, "c1"))
      .mockResolvedValueOnce(page([["last", true]], "c2"));

    expect(await recentContractTxs(["C1", "C2", "C3", "C4", "C5", "C6"], 3)).toEqual(["last", "t999", "t998"]);
    const [first, second] = requests(getEvents);
    expect(first.filters).toEqual([
      { type: "contract", contractIds: ["C1", "C2", "C3", "C4", "C5"] },
      { type: "contract", contractIds: ["C6"] },
    ]);
    expect(second).toEqual({ filters: first.filters, cursor: "c1", limit: 1000 });
  });

  it("asks nothing when there are no contracts", async () => {
    const spy = vi.spyOn(rpc.Server.prototype, "getHealth");
    expect(await recentContractTxs([], 40)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
