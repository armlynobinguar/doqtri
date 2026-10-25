import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  approvalEventFilter,
  approvalFromEvents,
  approvalRecorder,
  deferredRecorder,
  findApprovalTx,
  GIVE_UP_AFTER_MS,
  RESCAN_AFTER_MS,
  supabaseApprovalStore,
  type ApprovalKey,
  type ApprovalStore,
} from "@/lib/integrations/qdit-approvals";
import type { EventSource, LedgerEvent } from "@/lib/stellar/history";

/*
 * The approval-transaction lookup (WP-3.1). The event bytes are what qdit's
 * milestone_proof (integration/suite) publishes, captured from the Soroban
 * test host: m2 submitted twice and then approved (version 2), m3 submitted
 * and rejected (version 1).
 */

const EVENTS = {
  m2_submit_v2: {
    topics: [
      "AAAADwAAAARxZGl0",
      "AAAADwAAAAZzdWJtaXQAAA==",
      "AAAADgAAACQzZjZjMmExZS04YjRkLTRjN2UtOWExMC0yZDViN2U5ZjFjMzQ=",
    ],
    data: "AAAAEQAAAAEAAAAEAAAADwAAAAxtaWxlc3RvbmVfaWQAAAAOAAAAJGM5MmY1MDE4LTdiM2QtNGVhNC05ZjYwLTFkOGIwYzRlM2Y3MgAAAA8AAAAKcHJvb2ZfaGFzaAAAAAAADQAAACACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAA8AAAAJc3VibWl0dGVyAAAAAAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAA8AAAAHdmVyc2lvbgAAAAADAAAAAg==",
  },
  m2_approve_v2: {
    topics: [
      "AAAADwAAAARxZGl0",
      "AAAADwAAAAdhcHByb3ZlAA==",
      "AAAADgAAACQzZjZjMmExZS04YjRkLTRjN2UtOWExMC0yZDViN2U5ZjFjMzQ=",
    ],
    data: "AAAAEQAAAAEAAAADAAAADwAAAAhhcHByb3ZlcgAAABIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAPAAAADG1pbGVzdG9uZV9pZAAAAA4AAAAkYzkyZjUwMTgtN2IzZC00ZWE0LTlmNjAtMWQ4YjBjNGUzZjcyAAAADwAAAAd2ZXJzaW9uAAAAAAMAAAAC",
  },
  m3_reject_v1: {
    topics: [
      "AAAADwAAAARxZGl0",
      "AAAADwAAAAZyZWplY3QAAA==",
      "AAAADgAAACQzZjZjMmExZS04YjRkLTRjN2UtOWExMC0yZDViN2U5ZjFjMzQ=",
    ],
    data: "AAAAEQAAAAEAAAADAAAADwAAAAhhcHByb3ZlcgAAABIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAPAAAADG1pbGVzdG9uZV9pZAAAAA4AAAAkZDBhMzYxMjktOGM0ZS00ZmI1LThhNzEtMmU5YzFkNWY0MDgzAAAADwAAAAd2ZXJzaW9uAAAAAAMAAAAB",
  },
} as const;

const PROJECT = "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34";
const M2 = "c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72";
const M3 = "d0a36129-8c4e-4fb5-8a71-2e9c1d5f4083";
const CONTRACT = "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG";
const TX_A = "5e1f0c3a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d0f";
const TX_B = "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab";

const KEY: ApprovalKey = { network: "testnet", contractId: CONTRACT, projectId: PROJECT, milestoneId: M2, version: 2 };

function event(name: keyof typeof EVENTS, txHash: string, ledger: number, extra: Partial<LedgerEvent> = {}): LedgerEvent {
  const { topics, data } = EVENTS[name];
  return {
    topic: topics.map((t) => xdr.ScVal.fromXDR(t, "base64")),
    value: xdr.ScVal.fromXDR(data, "base64"),
    txHash,
    ledger,
    inSuccessfulContractCall: true,
    ...extra,
  };
}

describe("approvalEventFilter", () => {
  it("asks RPC for one project's approve events on its contract, by the topics milestone_proof publishes", () => {
    const filter = approvalEventFilter({ network: "testnet", contractId: CONTRACT }, PROJECT);
    expect(filter).toEqual({ type: "contract", contractIds: [CONTRACT], topics: [[...EVENTS.m2_approve_v2.topics]] });
  });
});

describe("approvalFromEvents", () => {
  it("finds the transaction that approved the milestone at that version", () => {
    const events = [event("m2_submit_v2", TX_B, 100), event("m2_approve_v2", TX_A, 120)];
    expect(approvalFromEvents(events, KEY)).toEqual({ txHash: TX_A, ledger: 120 });
  });

  it("ignores a submission, a rejection, another milestone and another version", () => {
    expect(approvalFromEvents([event("m2_submit_v2", TX_B, 100)], KEY)).toBeNull();
    expect(approvalFromEvents([event("m3_reject_v1", TX_B, 100)], { ...KEY, milestoneId: M3, version: 1 })).toBeNull();
    expect(approvalFromEvents([event("m2_approve_v2", TX_A, 120)], { ...KEY, milestoneId: M3 })).toBeNull();
    expect(approvalFromEvents([event("m2_approve_v2", TX_A, 120)], { ...KEY, version: 1 })).toBeNull();
  });

  it("ignores another project's event and a failed call's", () => {
    expect(approvalFromEvents([event("m2_approve_v2", TX_A, 120)], { ...KEY, projectId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
    expect(approvalFromEvents([event("m2_approve_v2", TX_A, 120, { inSuccessfulContractCall: false })], KEY)).toBeNull();
  });

  it("skips events that are not milestone_proof's shape, and keeps the newest match", () => {
    const junk: LedgerEvent = { topic: [xdr.ScVal.scvU32(1)], value: xdr.ScVal.scvVoid(), txHash: TX_B, ledger: 999, inSuccessfulContractCall: true };
    const events = [event("m2_approve_v2", TX_B, 110), junk, event("m2_approve_v2", TX_A, 130)];
    expect(approvalFromEvents(events, KEY)).toEqual({ txHash: TX_A, ledger: 130 });
  });

  it("refuses a hash that is not 64 hex characters, and lowercases one in capitals", () => {
    expect(approvalFromEvents([event("m2_approve_v2", "not-a-hash", 120)], KEY)).toBeNull();
    expect(approvalFromEvents([event("m2_approve_v2", TX_A.toUpperCase(), 120)], KEY)).toEqual({ txHash: TX_A, ledger: 120 });
  });
});

describe("findApprovalTx", () => {
  function source(events: LedgerEvent[]): EventSource & { getEvents: ReturnType<typeof vi.fn> } {
    return {
      getHealth: async () => ({ oldestLedger: 1, latestLedger: 200 }),
      getEvents: vi.fn(async () => ({ events, cursor: "" })),
    };
  }

  it("scans the network's RPC window with the approval filter and returns the match", async () => {
    const rpc = source([event("m2_approve_v2", TX_A, 120)]);
    const networks: string[] = [];
    const found = await findApprovalTx(KEY, { events: (n) => (networks.push(n), rpc) });
    expect(found).toEqual({ txHash: TX_A, ledger: 120 });
    expect(networks).toEqual(["testnet"]);
    const request = rpc.getEvents.mock.calls[0][0];
    expect(request.filters).toEqual([approvalEventFilter({ network: "testnet", contractId: CONTRACT }, PROJECT)]);
  });

  it("is bounded: a few pages at most", async () => {
    const rpc = source([event("m2_submit_v2", TX_B, 120)]);
    expect(await findApprovalTx(KEY, { events: () => rpc })).toBeNull();
    expect(rpc.getEvents.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("throws when RPC does not answer in time", async () => {
    const slow: EventSource = {
      getHealth: () => new Promise(() => {}),
      getEvents: async () => ({ events: [], cursor: "" }),
    };
    await expect(findApprovalTx(KEY, { events: () => slow, timeoutMs: 10 })).rejects.toThrow(/in time/);
  });
});

describe("approvalRecorder", () => {
  function store(
    has = false,
    miss: { firstAt: number; lastAt: number } | null = null,
  ): ApprovalStore & { record: ReturnType<typeof vi.fn>; recordMiss: ReturnType<typeof vi.fn> } {
    return {
      has: vi.fn(async () => has),
      record: vi.fn(async () => {}),
      miss: vi.fn(async () => miss),
      recordMiss: vi.fn(async () => {}),
      forMilestones: async () => [],
    };
  }

  it("looks the approval up and records it", async () => {
    const s = store();
    await approvalRecorder(s, async () => ({ txHash: TX_A, ledger: 120 }))(KEY);
    expect(s.record).toHaveBeenCalledWith(KEY, { txHash: TX_A, ledger: 120 });
  });

  it("does not scan again for an approval already recorded", async () => {
    const s = store(true);
    const find = vi.fn(async () => ({ txHash: TX_A, ledger: 120 }));
    await approvalRecorder(s, find)(KEY);
    expect(find).not.toHaveBeenCalled();
    expect(s.record).not.toHaveBeenCalled();
  });

  it("records a miss, not an approval, when the event is not in the window", async () => {
    const s = store();
    await approvalRecorder(s, async () => null)(KEY);
    expect(s.record).not.toHaveBeenCalled();
    expect(s.recordMiss).toHaveBeenCalledWith(KEY, false);
  });

  it("keeps looking within RPC's window of the first miss, and stops after it", async () => {
    const NOW = 1_800_000_000_000;
    const find = vi.fn(async () => null);
    const recent = store(false, { firstAt: NOW - GIVE_UP_AFTER_MS, lastAt: NOW - RESCAN_AFTER_MS });
    await approvalRecorder(recent, find, () => NOW)(KEY);
    expect(find).toHaveBeenCalledTimes(1);
    // A miss is on record, so only its last attempt moves.
    expect(recent.recordMiss).toHaveBeenCalledWith(KEY, true);

    const old = store(false, { firstAt: NOW - GIVE_UP_AFTER_MS - 1, lastAt: NOW - RESCAN_AFTER_MS });
    await approvalRecorder(old, find, () => NOW)(KEY);
    expect(find).toHaveBeenCalledTimes(1);
    expect(old.recordMiss).not.toHaveBeenCalled();
    expect(GIVE_UP_AFTER_MS).toBeGreaterThan(7 * 24 * 60 * 60_000);
  });

  it("scans a missed approval at most once an hour, however often it is seen", async () => {
    const NOW = 1_800_000_000_000;
    const find = vi.fn(async () => null);
    const justMissed = store(false, { firstAt: NOW - 60_000, lastAt: NOW - RESCAN_AFTER_MS + 1 });
    await approvalRecorder(justMissed, find, () => NOW)(KEY);
    expect(find).not.toHaveBeenCalled();
    expect(justMissed.recordMiss).not.toHaveBeenCalled();

    const hourAgo = store(false, { firstAt: NOW - 3 * RESCAN_AFTER_MS, lastAt: NOW - RESCAN_AFTER_MS });
    await approvalRecorder(hourAgo, find, () => NOW)(KEY);
    expect(find).toHaveBeenCalledTimes(1);
    expect(RESCAN_AFTER_MS).toBe(60 * 60_000);
  });

  it("a lookup that fails is not a miss: the next sighting tries again", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = store();
    await approvalRecorder(s, async () => {
      throw new Error("Stellar RPC did not answer in time.");
    })(KEY);
    expect(s.recordMiss).not.toHaveBeenCalled();
    expect(s.record).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("never throws: RPC or the database failing only costs the link", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = store();
    await expect(
      approvalRecorder(s, async () => {
        throw new Error("RPC down");
      })(KEY),
    ).resolves.toBeUndefined();
    s.has = async () => {
      throw new Error("db down");
    };
    await expect(approvalRecorder(s, async () => null)(KEY)).resolves.toBeUndefined();
    quiet.mockRestore();
  });
});

describe("deferredRecorder", () => {
  const key = (version: number): ApprovalKey => ({ ...KEY, version });

  it("resolves at once and records everything in one deferred task, a few at a time", async () => {
    const tasks: Array<() => Promise<void>> = [];
    let running = 0;
    let peak = 0;
    const record = vi.fn<(key: ApprovalKey) => Promise<void>>(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    });
    const deferred = deferredRecorder(record, (task) => void tasks.push(task));
    for (let v = 1; v <= 6; v += 1) await deferred(key(v));
    expect(record).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(record.mock.calls.map(([k]) => k.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBeLessThanOrEqual(4);
    // Keys handed over after the task started go in a new one.
    await deferred(key(7));
    expect(tasks).toHaveLength(2);
  });
});

describe("supabaseApprovalStore: misses", () => {
  /** A PostgREST builder fake that records what each call asked for. */
  function fakeAdmin(row: Record<string, string> | null = null) {
    const calls: Array<{ op: string; table: string; values?: unknown; match?: unknown }> = [];
    const from = (table: string) => {
      const builder = {
        select: () => builder,
        match: (m: unknown) => {
          const last = calls.at(-1);
          if (last && last.table === table && last.match === undefined && last.op !== "select") last.match = m;
          return builder;
        },
        maybeSingle: async () => ({ data: row, error: null }),
        upsert: (values: unknown) => (calls.push({ op: "upsert", table, values }), Promise.resolve({ error: null })),
        update: (values: unknown) => {
          calls.push({ op: "update", table, values });
          return { match: async (m: unknown) => ((calls.at(-1)!.match = m), { error: null }) };
        },
      };
      return builder;
    };
    return { admin: { from } as never, calls };
  }

  it("reads the first and last miss", async () => {
    const { admin } = fakeAdmin({ first_missed_at: "2026-10-01T00:00:00Z", last_attempt_at: "2026-10-02T00:00:00Z" });
    expect(await supabaseApprovalStore(admin).miss(KEY)).toEqual({
      firstAt: Date.parse("2026-10-01T00:00:00Z"),
      lastAt: Date.parse("2026-10-02T00:00:00Z"),
    });
    expect(await supabaseApprovalStore(fakeAdmin(null).admin).miss(KEY)).toBeNull();
  });

  it("inserts the first miss, and afterwards moves only last_attempt_at", async () => {
    const { admin, calls } = fakeAdmin();
    const s = supabaseApprovalStore(admin);
    await s.recordMiss(KEY, false);
    await s.recordMiss(KEY, true);
    expect(calls[0]).toMatchObject({ op: "upsert", table: "qdit_milestone_approval_misses" });
    expect(calls[0].values).not.toHaveProperty("last_attempt_at");
    expect(calls[1]).toMatchObject({ op: "update", table: "qdit_milestone_approval_misses" });
    expect(Object.keys(calls[1].values as object)).toEqual(["last_attempt_at"]);
    expect(calls[1].match).toMatchObject({ milestone_id: KEY.milestoneId, version: KEY.version });
  });
});
