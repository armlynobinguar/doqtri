import { describe, expect, it } from "vitest";
import {
  classifyOutcome,
  formatReport,
  latencyStats,
  parseServerLog,
  parseTimingLines,
  percentile,
  runPool,
  summarize,
  summarizeTimings,
  type WriteOutcome,
} from "./report";

const rejected = "The network rejected this transaction. Try again.";
const out = (o: Partial<WriteOutcome>): WriteOutcome => ({ wallet: 0, status: 200, ok: true, relayMs: 1_000, ...o });

describe("classifyOutcome", () => {
  it("names today's relay answers by status and reason", () => {
    expect(classifyOutcome({ status: 200, ok: true })).toBe("ok");
    expect(classifyOutcome({ status: 502, ok: false, error: rejected })).toBe("502 network rejected the transaction");
    expect(classifyOutcome({ status: 502, ok: false, error: "The transaction failed on-chain." })).toBe("502 failed on-chain after submit");
    expect(classifyOutcome({ status: 429, ok: false, error: "You've reached today's limit for on-chain actions." })).toBe(
      "429 per-user daily quota",
    );
  });

  it("keeps an unknown message's own words, shortened", () => {
    expect(classifyOutcome({ status: 504, ok: false, error: "FUNCTION_INVOCATION_TIMEOUT" })).toBe("504 FUNCTION_INVOCATION_TIMEOUT");
    expect(classifyOutcome({ status: 500, ok: false, error: "x".repeat(200) })).toHaveLength(84);
    expect(classifyOutcome({ status: 500, ok: false })).toBe("500 no error message");
  });

  it("tells a request that never got an answer apart", () => {
    expect(classifyOutcome({ status: 0, ok: false, error: "fetch failed" })).toBe("no response (fetch failed)");
  });
});

describe("parseServerLog", () => {
  it("splits the relay's paid-write failures by network code", () => {
    const log = [
      "GET /vault 200 in 120ms",
      "[chain/relay] paid write rejected: txBadSeq",
      "[chain/relay] paid write rejected: txBadSeq",
      "2026-11-01T10:00:00Z error [chain/relay] paid write rejected: TRY_AGAIN_LATER",
      "[chain/relay] paid write rejected: txInsufficientFee",
      "[chain/relay] paid write ab12cd ended FAILED",
      "[chain/relay] paid write simulation failed: HostError: Error(Contract, #10)",
      "[chain/relay] quota check failed: timeout",
    ].join("\n");
    expect(parseServerLog(log)).toEqual({
      txBadSeq: 2,
      TRY_AGAIN_LATER: 1,
      other: { "rejected: txInsufficientFee": 1, "ended FAILED": 1, "simulation failed": 1 },
    });
  });

  it("finds nothing in an unrelated log", () => {
    expect(parseServerLog("ready on :3000\n")).toEqual({ txBadSeq: 0, TRY_AGAIN_LATER: 0, other: {} });
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    expect(percentile(values, 50)).toBe(1_000);
    expect(percentile(values, 95)).toBe(1_900);
    expect(percentile(values, 100)).toBe(2_000);
    expect(percentile(values, 0)).toBe(100);
  });

  it("ignores input order and handles one or no values", () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(latencyStats([])).toEqual({ count: 0, p50: null, p95: null, min: null, max: null });
  });
});

describe("runPool", () => {
  it("never runs more than the limit at once and keeps input order", async () => {
    let running = 0;
    let peak = 0;
    const results = await runPool([30, 10, 20, 5, 15], 2, async (delay, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, delay));
      running--;
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("copes with no items", async () => {
    expect(await runPool([], 3, async () => 1)).toEqual([]);
  });
});

describe("summarize and formatReport", () => {
  const meta = { target: "http://localhost:3000", startedAt: "2026-11-01T10:00:00.000Z", n: 4 };
  const outcomes = [
    out({ wallet: 0, relayMs: 4_000, hash: "aa" }),
    out({ wallet: 1, status: 502, ok: false, error: rejected, relayMs: 9_000 }),
    out({ wallet: 2, status: 502, ok: false, error: rejected, relayMs: 12_000 }),
  ];
  const failures = [{ wallet: 3, step: "funding", error: "not funded within 120s" }];
  const log = { txBadSeq: 1, TRY_AGAIN_LATER: 1, other: {} };

  it("counts outcomes, success first, and keeps latency for all and for successes", () => {
    const s = summarize(meta, outcomes, failures, log, 12_500);
    expect(s.sent).toBe(3);
    expect(s.succeeded).toBe(1);
    expect(s.outcomes).toEqual([
      { outcome: "ok", count: 1 },
      { outcome: "502 network rejected the transaction", count: 2 },
    ]);
    expect(s.relayMs).toMatchObject({ count: 3, p50: 9_000, p95: 12_000 });
    expect(s.successMs).toMatchObject({ count: 1, p50: 4_000 });
  });

  it("reports counts, the log split, latency and wallets that never sent", () => {
    const md = formatReport(summarize(meta, outcomes, failures, log, 12_500));
    expect(md).toContain("1 of 3 relay requests succeeded; 1 wallet never reached the relay.");
    expect(md).toContain("| 502 network rejected the transaction | 2 |");
    expect(md).toContain("| txBadSeq | 1 |");
    expect(md).toContain("| TRY_AGAIN_LATER | 1 |");
    expect(md).toContain("| all 3 requests | 9.00 s | 12.00 s | 4.00 s | 12.00 s |");
    expect(md).toContain("| 3 | funding | not funded within 120s |");
  });

  it("says when 502s cannot be split for want of a log", () => {
    expect(formatReport(summarize(meta, outcomes, [], null, 12_500))).toContain("No server log was given");
  });
});

describe("server timing lines (RELAY_TIMING, DOQ-8)", () => {
  const timing = (o: Record<string, unknown>) => ({
    v: 1,
    path: "pool",
    status: "confirmed",
    hash: "aa",
    channel: 1,
    ms: { funded: 0, lease: 10, state: 1_000, simulateMeasure: 500, simulateCharge: 500, send: 300, poll: 4_000, release: 10 },
    calls: {},
    totalMs: 6_400,
    otherMs: 80,
    leaseTries: 1,
    attempts: 1,
    pollRounds: 4,
    sentLedger: 100,
    landedLedger: 101,
    pollAfterCloseMs: 900,
    startedAt: "2026-11-02T00:00:00.000Z",
    ...o,
  });
  const line = (o: Record<string, unknown> = {}) => `2026-11-02 [chain/relay] timing ${JSON.stringify(timing(o))}`;

  it("reads the relay's timing lines and skips everything else", () => {
    const log = [line(), "[chain/relay] paid write rejected: txBadSeq", '[chain/relay] timing {"v":1,"cut', line({ hash: "bb" })].join("\n");
    expect(parseTimingLines(log).map((t) => t.hash)).toEqual(["aa", "bb"]);
  });

  it("summarizes steps, ledgers after send and time outside submitPaidWrite", () => {
    const timings = parseTimingLines([line(), line({ hash: "bb", landedLedger: 102, totalMs: 11_400, ms: { poll: 9_000 } })].join("\n"));
    const outcomes = [out({ hash: "aa", relayMs: 6_500 }), out({ hash: "bb", relayMs: 11_600 }), out({ hash: "cc" })];
    const t = summarizeTimings(timings, outcomes)!;
    expect(t.writes).toBe(2);
    expect(t.ledgersAfterSend).toEqual([
      { ledgers: 1, count: 1 },
      { ledgers: 2, count: 1 },
    ]);
    expect(t.outsideSubmit).toMatchObject({ count: 2, min: 100, max: 200 });
    const poll = t.steps.find((s) => s.step === "poll")!;
    expect(poll.stats).toMatchObject({ min: 4_000, max: 9_000 });
    expect(poll.share).toBeCloseTo(13_000 / 17_800);
    // A step a write skipped counts as 0 for it.
    expect(t.steps.find((s) => s.step === "state")!.stats.min).toBe(0);
    expect(summarizeTimings([])).toBeNull();
  });

  it("adds a where-the-time-goes section to the report when there are timing lines", () => {
    const s = summarize({ target: "http://localhost:3100", startedAt: "t", n: 1 }, [out({ hash: "aa" })], [], null, 1_000, parseTimingLines(line()));
    const md = formatReport(s);
    expect(md).toContain("### Where the time goes (server timing, 1 pooled writes)");
    expect(md).toContain("| poll | 4.00 s |");
    expect(md).toContain("| +1 | 1 |");
    expect(formatReport(summarize({ target: "x", startedAt: "t", n: 1 }, [out({})], [], null, 1_000))).not.toContain("Where the time goes");
  });
});
