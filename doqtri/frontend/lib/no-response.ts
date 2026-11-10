/**
 * A request that got no answer: the network dropped, or it timed out. Unlike
 * a refusal, the server may have done the work before the answer was lost, so
 * the UI says the change may not have saved rather than that it failed.
 */
export class NoResponseError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("No answer from the server", options);
    this.name = "NoResponseError";
  }
}

/**
 * Long enough for a delete, which asks Stellar whether the note is anchored
 * first; short enough that a request that hangs does not leave a note's row
 * pending (and its rename and delete disabled) until the tab is closed.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** `fetch`, with a timeout, rejecting with NoResponseError when no answer came. */
export async function fetchOrNoResponse(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    throw new NoResponseError({ cause });
  }
}

/**
 * Statuses a gateway or proxy answers with when the app itself did not (a
 * timeout, or the server unreachable behind it), plus 0, which supabase-js
 * reports when the request never got an answer. They say nothing about
 * whether the change happened. The app's own routes use 503 too (Stellar
 * unreachable, nothing changed), so one only counts as no answer when its
 * body is not one of the app's JSON refusals.
 */
const GATEWAY_STATUSES = new Set([0, 408, 502, 503, 504]);

export function isNoAnswer(status: number, payload: unknown = null): boolean {
  if (!GATEWAY_STATUSES.has(status)) return false;
  const refusal =
    payload !== null && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string";
  return !refusal;
}

/**
 * Whether the app's server answers at all, before a router.refresh() that
 * would make Next reload the whole page if it did not. Next answers OPTIONS
 * on a route handler itself, without running the handler, so this costs the
 * server next to nothing; `navigator.onLine` alone misses a server that is
 * down or a network that only reaches a captive portal.
 */
export async function isServerReachable(): Promise<boolean> {
  try {
    const res = await fetch("/api/stats", {
      method: "OPTIONS",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * The response's JSON body, or null when it is not JSON. A body cut off on
 * the way (the timeout, or the network dropping mid-read) rejects with
 * NoResponseError: the status arrived, but the rest of the answer did not.
 */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (cause) {
    if (cause instanceof SyntaxError) return null;
    throw new NoResponseError({ cause });
  }
}
