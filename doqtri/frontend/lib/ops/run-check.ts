import { logError } from "@/lib/log-error";
import { sortChecks } from "@/lib/ops/levels";
import type { OpsCheck, OpsCheckDef, OpsResult } from "@/lib/ops/types";

/** How long one check may take before it reads as unknown. */
export const CHECK_TIMEOUT_MS = 5_000;

/**
 * Runs one check. A check that throws or takes longer than `timeoutMs` reads
 * as unknown, so one dead dependency never blanks the page. What it threw is
 * logged with logError (which masks a keyed RPC URL) and never shown: error
 * messages from SDKs and fetch can quote URLs and headers.
 */
export async function runCheck(def: OpsCheckDef, timeoutMs = CHECK_TIMEOUT_MS): Promise<OpsCheck> {
  const { id, section, label } = def;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<OpsResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: "unknown", value: "—", detail: `No answer within ${timeoutMs / 1000} s` }),
      timeoutMs,
    );
  });
  try {
    const result = await Promise.race([def.run(), timeout]);
    return { id, section, label, ...result };
  } catch (error) {
    logError(`[admin/ops] ${id}`, error);
    return { id, section, label, status: "unknown", value: "—", detail: "The check failed; see the server log" };
  } finally {
    clearTimeout(timer);
  }
}

/** Every check at once, worst first. */
export async function runChecks(defs: OpsCheckDef[], timeoutMs = CHECK_TIMEOUT_MS): Promise<OpsCheck[]> {
  return sortChecks(await Promise.all(defs.map((def) => runCheck(def, timeoutMs))));
}

/** One shared call for several checks: the first caller starts it, the rest wait on it. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}

/**
 * Remembers each key's answer for `ttlMs`, across reports: for reads that
 * change slowly and cost a request each (Horizon balances, metered RPC
 * entries). A failed read is not remembered.
 */
export function memoize<T>(load: (key: string) => Promise<T>, ttlMs: number, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string): Promise<T> => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = load(key);
    cache.set(key, { at: now(), value });
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  };
}

/** Each key loaded once for the life of the returned function, failures included: one report's reads. */
export function onceEach<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key) => {
    let value = cache.get(key);
    if (!value) {
      value = load(key);
      cache.set(key, value);
    }
    return value;
  };
}

/** `promise`, or a rejection after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
