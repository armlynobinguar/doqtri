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
const TIMEOUT_MS = 30_000;

/** `fetch`, with a timeout, rejecting with NoResponseError when no answer came. */
export async function fetchOrNoResponse(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new NoResponseError({ cause });
  }
}
