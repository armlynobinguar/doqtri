/**
 * Telling a refused write from one that got no answer (DOQ-33, WP-1.7).
 *
 * Screens that show a change before the server confirms it roll the change
 * back when the write fails. A refusal means nothing changed, so the server's
 * message is the right thing to show. With no answer (the network dropped,
 * the request timed out, a gateway gave up) the write may still have landed,
 * so the screen says the change may not have saved instead of claiming it
 * failed. Pure and browser-safe.
 */

/**
 * A write that got no answer from the database. Its message is the client
 * library's own (e.g. "TypeError: Failed to fetch"), kept for logs; people see
 * UNCONFIRMED_WRITE instead.
 */
export class UnconfirmedWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnconfirmedWriteError";
  }
}

export const UNCONFIRMED_WRITE = "No answer from the server, so this change may not have saved. Refresh to check.";

/**
 * Whether an HTTP status means the request got no real answer. supabase-js
 * reports a fetch that never reached PostgREST as status 0; 408, 502 to 504
 * and Cloudflare's 520 to 524 are timeouts and gateway failures in front of
 * it, where the database may or may not have run the write.
 */
export function isUnanswered(status: number): boolean {
  return status === 0 || status === 408 || (status >= 502 && status <= 504) || (status >= 520 && status <= 524);
}

/** The error to throw for a supabase-js `{ error, status }` result. */
export function supabaseWriteError(error: { message: string }, status: number): Error {
  return isUnanswered(status) ? new UnconfirmedWriteError(error.message) : new Error(error.message);
}

/**
 * Whether a failed write may still have landed. A plain Error is a refusal
 * we raised from the server's answer. An unconfirmed write may have landed,
 * and so may anything else thrown: fetch rejects with a TypeError when the
 * network drops.
 */
export function mayHaveLanded(error: unknown): boolean {
  return error instanceof UnconfirmedWriteError || error instanceof TypeError || !(error instanceof Error);
}

/** What to tell someone whose optimistic change was rolled back. */
export function writeFailureMessage(error: unknown, fallback: string): string {
  if (mayHaveLanded(error)) return UNCONFIRMED_WRITE;
  return (error as Error).message || fallback;
}
