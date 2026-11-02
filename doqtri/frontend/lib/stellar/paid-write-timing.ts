/**
 * Step timings for pooled paid writes (WP-4.1, DOQ-8), off by default.
 *
 * With RELAY_TIMING=on, each paid write sent from a leased channel logs one
 * line when it ends:
 *
 *   [chain/relay] timing {"v":1,"path":"pool","status":"confirmed",...}
 *
 * The line holds how long each step took (funding check, lease, chain state,
 * each simulation, submit, poll, release), how many lease and poll rounds
 * there were, the ledger the RPC was on when the write was sent and the one
 * it landed in, and how long after that ledger closed the poll noticed. It
 * holds public facts only: a transaction hash, a channel index and ledger
 * numbers, never a key, an RPC URL or a request body. The load test reads
 * these lines from the server log (scripts/load-test/report.ts).
 *
 * The timer wraps the RPC (simulations, submit, poll) and the pool store;
 * direct-submit.ts times its other steps with span(). Steps never overlap.
 * Off, every hook is a no-op and the RPC and store are passed through
 * untouched, so the write runs exactly the same either way.
 */
import { rpc } from "@stellar/stellar-sdk";
import type { ChannelPoolStore } from "@/lib/stellar/channel-pool";

/** The RPC calls a channel write makes (direct-submit.ts's PaidWriteRpc). */
type TimedRpc = Pick<
  rpc.Server,
  "getLatestLedger" | "getAccount" | "simulateTransaction" | "sendTransaction" | "pollTransaction"
>;

/** RELAY_TIMING=on logs one timing line per pooled paid write. */
export function relayTimingEnabled(): boolean {
  return process.env.RELAY_TIMING?.trim().replace(/^["']|["']$/g, "").toLowerCase() === "on";
}

/** What one write's timing line holds. */
export type PaidWriteTiming = {
  v: 1;
  path: "pool";
  /** confirmed, pending, or the HTTP status of the refusal (e.g. "502"), or "error". */
  status: string;
  hash: string | null;
  channel: number | null;
  /** Milliseconds per step, in the order they first ran; repeated steps add up. */
  ms: Record<string, number>;
  /** Calls per step, where a step ran more than once. */
  calls: Record<string, number>;
  /** From entering submitFromChannel to the release returning. */
  totalMs: number;
  /** totalMs minus the timed steps: signing, building, assembling. */
  otherMs: number;
  /** lease_relay_channel() calls this write made (1 when a channel was free at once). */
  leaseTries: number;
  /** sendTransaction calls. */
  attempts: number;
  /** getTransaction rounds inside the poll. */
  pollRounds: number;
  /** The RPC's latest ledger in the accepted sendTransaction's answer. */
  sentLedger: number | null;
  /** The ledger the write landed in. */
  landedLedger: number | null;
  /** Wall-clock ms from that ledger's close time to the poll's answer. */
  pollAfterCloseMs: number | null;
  /** Wall-clock time the write started, ISO. */
  startedAt: string;
};

export type PaidWriteTimer = {
  /** Times `run` under `step`. */
  span<T>(step: string, run: () => Promise<T>): Promise<T>;
  /** The RPC, with each call timed under its own step. */
  rpc<S extends TimedRpc>(server: S): S;
  /** The pool store, with lease tries counted and release timed. */
  pool(store: ChannelPoolStore): ChannelPoolStore;
  channel(idx: number): void;
  /** Logs the line. `outcome` is the result or the thrown error. */
  finish(outcome: { status: string; hash?: string | null }): void;
};

const NOOP: PaidWriteTimer = {
  span: (_step, run) => run(),
  rpc: (server) => server,
  pool: (store) => store,
  channel: () => {},
  finish: () => {},
};

/** A timer when RELAY_TIMING is on, else hooks that do nothing. */
export function paidWriteTimer(
  now: () => number = Date.now,
  wallClock: () => number = Date.now,
  log: (line: string) => void = (line) => console.info(line),
): PaidWriteTimer {
  if (!relayTimingEnabled()) return NOOP;
  return createPaidWriteTimer(now, wallClock, log);
}

/** The timer itself, whatever RELAY_TIMING says (for tests). */
export function createPaidWriteTimer(
  now: () => number,
  wallClock: () => number,
  log: (line: string) => void,
): PaidWriteTimer {
  const started = now();
  const startedAt = new Date(wallClock()).toISOString();
  const ms: Record<string, number> = {};
  const calls: Record<string, number> = {};
  const facts = {
    channel: null as number | null,
    leaseTries: 0,
    attempts: 0,
    pollRounds: 0,
    sentLedger: null as number | null,
    landedLedger: null as number | null,
    pollAfterCloseMs: null as number | null,
  };
  let simulations = 0;

  const span = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
    const t0 = now();
    try {
      return await run();
    } finally {
      ms[step] = (ms[step] ?? 0) + (now() - t0);
      calls[step] = (calls[step] ?? 0) + 1;
    }
  };

  return {
    span,
    rpc(server) {
      const timed: TimedRpc = {
        // Ledger and account reads run in parallel; the caller times them
        // together as one step ("state", "retryWait"), not one by one.
        getLatestLedger: () => server.getLatestLedger(),
        getAccount: (address) => server.getAccount(address),
        // The first simulation measures the fee, the rest charge it.
        simulateTransaction: (tx, ...rest) =>
          span(simulations++ === 0 ? "simulateMeasure" : "simulateCharge", () => server.simulateTransaction(tx, ...rest)),
        sendTransaction: async (tx) => {
          facts.attempts++;
          const sent = await span("send", () => server.sendTransaction(tx));
          if (sent.status === "PENDING" || sent.status === "DUPLICATE") facts.sentLedger = sent.latestLedger;
          return sent;
        },
        pollTransaction: async (hash, opts) => {
          const sleepStrategy = opts?.sleepStrategy ?? rpc.BasicSleepStrategy;
          const result = await span("poll", () =>
            server.pollTransaction(hash, {
              ...opts,
              sleepStrategy: (attempt) => {
                facts.pollRounds = attempt;
                return sleepStrategy(attempt);
              },
            }),
          );
          // The round that found it (or the last one) never slept.
          facts.pollRounds++;
          if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
            facts.landedLedger = result.ledger;
            facts.pollAfterCloseMs = wallClock() - result.createdAt * 1000;
          }
          return result;
        },
      };
      // Anything else on the server (none today) stays as it was.
      return Object.assign(Object.create(server), timed) as typeof server;
    },
    pool(store) {
      return {
        lease: (network, ttl) => {
          facts.leaseTries++;
          return store.lease(network, ttl);
        },
        release: (idx, leaseId, nextSeq) => span("release", () => store.release(idx, leaseId, nextSeq)),
      };
    },
    channel(idx) {
      facts.channel = idx;
    },
    finish(outcome) {
      const totalMs = now() - started;
      // Steps never overlap, so what they don't cover is the code between them.
      const timed = Object.values(ms).reduce((sum, value) => sum + value, 0);
      const line: PaidWriteTiming = {
        v: 1,
        path: "pool",
        status: outcome.status,
        hash: outcome.hash ?? null,
        channel: facts.channel,
        ms,
        calls: Object.fromEntries(Object.entries(calls).filter(([, n]) => n > 1)),
        totalMs,
        otherMs: Math.max(0, totalMs - timed),
        leaseTries: facts.leaseTries,
        attempts: facts.attempts,
        pollRounds: facts.pollRounds,
        sentLedger: facts.sentLedger,
        landedLedger: facts.landedLedger,
        pollAfterCloseMs: facts.pollAfterCloseMs,
        startedAt,
      };
      log(`[chain/relay] timing ${JSON.stringify(line)}`);
    },
  };
}
