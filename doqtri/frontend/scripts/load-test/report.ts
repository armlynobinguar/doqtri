/**
 * The pure half of the paid-write load test (DOQ-2, WP-4.1): running tasks
 * with bounded concurrency, sorting each relay answer into an outcome,
 * reading the relay's own log lines, percentiles, and the report that is
 * posted on DOQ-1. No network here; report.test.ts covers it.
 *
 * The relay answers every rejected submission with the same 502 ("The
 * network rejected this transaction"), so which network code it was
 * (txBadSeq, TRY_AGAIN_LATER, …) is only in the server's log line
 * `[chain/relay] paid write rejected: <code>`. The report counts those lines
 * from the deployment's log when one is given.
 *
 * With RELAY_TIMING=on on the deployment (DOQ-8), the relay also logs one
 * `[chain/relay] timing {...}` line per pooled write, and the report shows
 * where each write's time went, step by step (lib/stellar/paid-write-timing.ts).
 */
import type { PaidWriteTiming } from "@/lib/stellar/paid-write-timing";

/** One relay request as the driver saw it. */
export type WriteOutcome = {
  /** Which test wallet sent it. */
  wallet: number;
  /** HTTP status; 0 when no response came back at all. */
  status: number;
  /** The relay's `{ success, data: { hash } }` came back. */
  ok: boolean;
  hash?: string;
  /** The relay's `error`, or the fetch failure. */
  error?: string;
  /** From sending the request to the full response, in ms. */
  relayMs: number;
};

/** A test wallet whose write never reached the relay (sign-in, note, simulation, signing). */
export type PrepareFailure = { wallet: number; step: string; error: string };

/**
 * Today's relay messages (app/api/chain/relay/route.ts, direct-submit.ts),
 * shortened for the report. Anything else is reported by its own text.
 */
const KNOWN_ERRORS: Record<string, string> = {
  "The network rejected this transaction. Try again.": "network rejected the transaction",
  "The transaction failed on-chain.": "failed on-chain after submit",
  "The transaction would fail on-chain": "simulation failed",
  "Your wallet doesn't have enough XLM for this. Top it up and try again.": "wallet balance too low",
  "This write costs more than the most you approved. Try again.": "fee above the approved maximum",
  "You've reached today's limit for on-chain actions.": "per-user daily quota",
  "Doqtri's on-chain actions are paused for today. Try again tomorrow.": "global daily quota",
  "On-chain actions are temporarily unavailable.": "quota check failed",
  "Paid writes are not configured": "relayer key not configured",
  "Paid writes are misconfigured on this server": "relayer key mismatch",
  "Sign in to continue.": "not signed in",
  "Something went wrong submitting this transaction.": "unexpected server error",
};

/** `ok`, or `<status> <reason>`: the row an outcome is counted under. */
export function classifyOutcome(outcome: Pick<WriteOutcome, "status" | "ok" | "error">): string {
  if (outcome.ok) return "ok";
  if (outcome.status === 0) return `no response (${shorten(outcome.error ?? "fetch failed")})`;
  const reason = outcome.error ? (KNOWN_ERRORS[outcome.error] ?? shorten(outcome.error)) : "no error message";
  return `${outcome.status} ${reason}`;
}

function shorten(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What the relay logged about paid writes, by network code. */
export type ServerLogCounts = { txBadSeq: number; TRY_AGAIN_LATER: number; other: Record<string, number> };

const REJECTED = /\[chain\/relay\] paid write rejected: (\S+)/;
const ENDED = /\[chain\/relay\] paid write \S+ ended (\S+)/;
const SIMULATION = /\[chain\/relay\] paid write simulation failed/;

/**
 * Counts the relay's paid-write failure lines in a server log: `rejected:
 * <code>` (the 502 above; only the last attempt is logged, after up to two
 * retries on txBadSeq / TRY_AGAIN_LATER), `<hash> ended <status>`, and
 * simulation failures.
 */
export function parseServerLog(text: string): ServerLogCounts {
  const counts: ServerLogCounts = { txBadSeq: 0, TRY_AGAIN_LATER: 0, other: {} };
  const bump = (key: string) => (counts.other[key] = (counts.other[key] ?? 0) + 1);
  for (const line of text.split("\n")) {
    const rejected = REJECTED.exec(line);
    if (rejected) {
      const code = rejected[1];
      if (code === "txBadSeq" || code === "TRY_AGAIN_LATER") counts[code]++;
      else bump(`rejected: ${code}`);
      continue;
    }
    const ended = ENDED.exec(line);
    if (ended) bump(`ended ${ended[1]}`);
    else if (SIMULATION.test(line)) bump("simulation failed");
  }
  return counts;
}

const TIMING = /\[chain\/relay\] timing (\{.*\})\s*$/;

/** The relay's per-write timing lines (RELAY_TIMING=on) in a server log. */
export function parseTimingLines(text: string): PaidWriteTiming[] {
  const timings: PaidWriteTiming[] = [];
  for (const line of text.split("\n")) {
    const match = TIMING.exec(line);
    if (!match) continue;
    try {
      const timing = JSON.parse(match[1]) as PaidWriteTiming;
      if (timing.v === 1) timings.push(timing);
    } catch {
      // A line cut short by the log; skip it.
    }
  }
  return timings;
}

/** The steps a pooled write runs, in order; "other" is the code between them. */
export const TIMING_STEPS = [
  "funded",
  "lease",
  "state",
  "simulateMeasure",
  "simulateCharge",
  "send",
  "retryWait",
  "poll",
  "release",
  "other",
] as const;

export type TimingSummary = {
  writes: number;
  /** Per step: the spread across writes (a write that skipped a step counts 0) and its mean share of the total. */
  steps: { step: string; stats: LatencyStats; share: number }[];
  total: LatencyStats;
  /** The client's relay time minus the server's, matched by hash: auth, checks, quota, HTTP. */
  outsideSubmit: LatencyStats;
  /** landedLedger − sentLedger, as count of writes per difference. */
  ledgersAfterSend: { ledgers: number; count: number }[];
  pollAfterClose: LatencyStats;
  pollRounds: LatencyStats;
  leaseTries: LatencyStats;
  /** sendTransaction calls per write. */
  attempts: { attempts: number; count: number }[];
};

function histogram(values: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Map([...counts].sort((a, b) => a[0] - b[0]));
}

/** Where the time went, across the run's timing lines; null when there are none. */
export function summarizeTimings(timings: PaidWriteTiming[], outcomes: WriteOutcome[] = []): TimingSummary | null {
  if (timings.length === 0) return null;
  const step = (t: PaidWriteTiming, name: string) => (name === "other" ? t.otherMs : (t.ms[name] ?? 0));
  const totalSum = timings.reduce((sum, t) => sum + t.totalMs, 0) || 1;
  const byHash = new Map(timings.filter((t) => t.hash).map((t) => [t.hash!, t]));
  const outside = outcomes.flatMap((o) => {
    const t = o.hash ? byHash.get(o.hash) : undefined;
    return t ? [o.relayMs - t.totalMs] : [];
  });
  const landed = timings.filter((t) => t.sentLedger !== null && t.landedLedger !== null);
  return {
    writes: timings.length,
    steps: TIMING_STEPS.map((name) => ({
      step: name,
      stats: latencyStats(timings.map((t) => step(t, name))),
      share: timings.reduce((sum, t) => sum + step(t, name), 0) / totalSum,
    })),
    total: latencyStats(timings.map((t) => t.totalMs)),
    outsideSubmit: latencyStats(outside),
    ledgersAfterSend: [...histogram(landed.map((t) => t.landedLedger! - t.sentLedger!))].map(([ledgers, count]) => ({ ledgers, count })),
    pollAfterClose: latencyStats(timings.flatMap((t) => (t.pollAfterCloseMs === null ? [] : [t.pollAfterCloseMs]))),
    pollRounds: latencyStats(timings.filter((t) => t.pollRounds > 0).map((t) => t.pollRounds)),
    leaseTries: latencyStats(timings.map((t) => t.leaseTries)),
    attempts: [...histogram(timings.map((t) => t.attempts))].map(([attempts, count]) => ({ attempts, count })),
  };
}

/** Nearest-rank percentile (p in 0–100); null for no values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export type LatencyStats = { count: number; p50: number | null; p95: number | null; min: number | null; max: number | null };

export function latencyStats(values: number[]): LatencyStats {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

/**
 * Runs `fn` over `items`, at most `limit` at a time, keeping input order in
 * the results. Used for setup and preparation, which are not what is
 * measured; the measured requests are all sent at once.
 */
export async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export type RunMeta = {
  target: string;
  startedAt: string;
  /** Wallets asked for (N). */
  n: number;
  /** Version or commit of the deployment, when known. */
  deployment?: string;
};

export type Summary = RunMeta & {
  /** Requests that reached the relay. */
  sent: number;
  succeeded: number;
  outcomes: { outcome: string; count: number }[];
  prepareFailures: PrepareFailure[];
  serverLog: ServerLogCounts | null;
  relayMs: LatencyStats;
  /** Latency of the successful requests only. */
  successMs: LatencyStats;
  /** From the first request out to the last answer back, in ms. */
  wallMs: number;
  /** Server step timings, when the deployment logged them. */
  timing?: TimingSummary | null;
};

export function summarize(
  meta: RunMeta,
  outcomes: WriteOutcome[],
  prepareFailures: PrepareFailure[],
  serverLog: ServerLogCounts | null,
  wallMs: number,
  timings: PaidWriteTiming[] = [],
): Summary {
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    const key = classifyOutcome(o);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    ...meta,
    sent: outcomes.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    outcomes: [...counts]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => (a.outcome === "ok" ? -1 : b.outcome === "ok" ? 1 : b.count - a.count || a.outcome.localeCompare(b.outcome))),
    prepareFailures,
    serverLog,
    relayMs: latencyStats(outcomes.map((o) => o.relayMs)),
    successMs: latencyStats(outcomes.filter((o) => o.ok).map((o) => o.relayMs)),
    wallMs,
    timing: summarizeTimings(timings, outcomes),
  };
}

const ms = (value: number | null) => (value === null ? "–" : `${(value / 1000).toFixed(2)} s`);

/** The report as Markdown, ready to paste as a Jira comment. */
export function formatReport(s: Summary): string {
  const lines = [
    `## Paid-write load test: N=${s.n}`,
    "",
    `Target ${s.target}${s.deployment ? ` (${s.deployment})` : ""}, started ${s.startedAt}.`,
    `${s.succeeded} of ${s.sent} relay requests succeeded` +
      (s.prepareFailures.length
        ? `; ${s.prepareFailures.length} wallet${s.prepareFailures.length === 1 ? "" : "s"} never reached the relay.`
        : "."),
    "",
    "| Outcome (HTTP status + reason) | Count |",
    "| --- | ---: |",
    ...s.outcomes.map((o) => `| ${o.outcome} | ${o.count} |`),
    "",
  ];
  if (s.serverLog) {
    const other = Object.entries(s.serverLog.other).sort((a, b) => b[1] - a[1]);
    const otherTotal = other.reduce((n, [, c]) => n + c, 0);
    lines.push(
      "| Server log: paid-write failures | Count |",
      "| --- | ---: |",
      `| txBadSeq | ${s.serverLog.txBadSeq} |`,
      `| TRY_AGAIN_LATER | ${s.serverLog.TRY_AGAIN_LATER} |`,
      `| other | ${otherTotal} |`,
      ...other.map(([code, count]) => `| · ${code} | ${count} |`),
      "",
    );
  } else {
    lines.push("No server log was given, so 502s are not split into txBadSeq / TRY_AGAIN_LATER / other.", "");
  }
  lines.push(
    "| Relay latency | p50 | p95 | min | max |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| all ${s.relayMs.count} requests | ${ms(s.relayMs.p50)} | ${ms(s.relayMs.p95)} | ${ms(s.relayMs.min)} | ${ms(s.relayMs.max)} |`,
    `| ${s.successMs.count} successes | ${ms(s.successMs.p50)} | ${ms(s.successMs.p95)} | ${ms(s.successMs.min)} | ${ms(s.successMs.max)} |`,
    "",
    `All requests were sent at once; the last answer came back after ${ms(s.wallMs)}.`,
  );
  if (s.timing) lines.push("", ...formatTiming(s.timing));
  if (s.prepareFailures.length) {
    lines.push("", "| Wallet | Failed before the relay at | Error |", "| ---: | --- | --- |");
    lines.push(...s.prepareFailures.map((f) => `| ${f.wallet} | ${f.step} | ${shorten(f.error, 120)} |`));
  }
  return lines.join("\n") + "\n";
}

const pct = (share: number) => `${(share * 100).toFixed(0)}%`;
const row = (label: string, st: LatencyStats, share?: number) =>
  `| ${label} | ${ms(st.p50)} | ${ms(st.p95)} | ${ms(st.min)} | ${ms(st.max)} | ${share === undefined ? "" : pct(share)} |`;

/** The server-timing section: steps, then what the ledger and the poll did. */
export function formatTiming(t: TimingSummary): string[] {
  const n = (st: LatencyStats) => (st.p50 === null ? "–" : `p50 ${st.p50}, max ${st.max}`);
  return [
    `### Where the time goes (server timing, ${t.writes} pooled writes)`,
    "",
    "| Step | p50 | p95 | min | max | share of total |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...t.steps.map((s) => row(s.step, s.stats, s.share)),
    row("**submitPaidWrite total**", t.total, 1),
    row("outside submitPaidWrite (auth, checks, quota, HTTP)", t.outsideSubmit),
    "",
    "| Ledgers between send and landing | Writes |",
    "| ---: | ---: |",
    ...t.ledgersAfterSend.map((l) => `| +${l.ledgers} | ${l.count} |`),
    "",
    `Poll answered ${ms(t.pollAfterClose.p50)} (p50) / ${ms(t.pollAfterClose.p95)} (p95) after the landing ledger closed; ` +
      `poll rounds ${n(t.pollRounds)}; lease tries ${n(t.leaseTries)}; ` +
      `sendTransaction calls per write: ${t.attempts.map((a) => `${a.attempts}×${a.count}`).join(", ")}.`,
  ];
}
