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
