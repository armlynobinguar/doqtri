import { createSaveQueue, type SaveQueue } from "@/lib/save-queue";
import { EDITING_ELSEWHERE, editingMessage } from "@/lib/doc-lock";
import type { DocLockController } from "@/lib/doc-lock-client";

/**
 * The editor's save path (WP-1.6, D-17): a save queue whose writes hold the
 * edit lock and go to PUT /api/notes/[id] with the version the text is based
 * on and the editor's edit session, keeping that version current as saves
 * land.
 *
 *   no lock to be had     the write fails; nothing is sent
 *   423 (lock lost)       the lock status is re-read, so the editor goes
 *                         read-only and names the holder
 *   409 (stale version)   `onConflict` is called; the editor must reload
 *                         before saving again, and nothing is overwritten
 *
 * `leave()` is the editor's last save as it closes (DOQ-43): the server
 * releases the lock once it is done, and the request outlives the page when
 * it can (a keepalive request carries at most 64 KiB). It gives up after
 * `leaveTimeoutMs`, queue wait included, aborting its request: a failed save,
 * so the editor keeps the text.
 */
export type NoteSaver = {
  queue: SaveQueue;
  /** The save version the stored text is at, as far as this editor knows. */
  readonly version: number;
  /** Adopts `version`, for text loaded or written elsewhere (reload, regenerate). */
  setVersion(version: number): void;
  /**
   * Saves `text` as the last write, after any in flight; the server then
   * releases the lock. `outlivesPage` says whether that request has gone
   * out as one that survives the page unloading.
   */
  leave(text: string): { done: Promise<void>; outlivesPage: () => boolean };
};

/** How long an editor's last save may take, waiting for earlier ones included. */
export const LEAVE_TIMEOUT_MS = 10_000;

/** Bytes, under the browsers' 64 KiB keepalive budget, with room for the headers. */
const KEEPALIVE_BODY_LIMIT = 60_000;

/** Fetch options for the last write: its abort signal, and keepalive when the body fits. */
function leaveOptions(leaving: { signal: AbortSignal; keepalive: boolean }, body: string): RequestInit {
  leaving.keepalive = new TextEncoder().encode(body).length <= KEEPALIVE_BODY_LIMIT;
  return leaving.keepalive ? { signal: leaving.signal, keepalive: true } : { signal: leaving.signal };
}

export function createNoteSaver(params: {
  docId: string;
  markdown: string;
  version: number;
  lock: Pick<DocLockController, "session" | "ensure" | "refresh" | "getState">;
  onConflict: () => void;
  fetchImpl?: typeof fetch;
  leaveTimeoutMs?: number;
}): NoteSaver {
  const { docId, lock, onConflict } = params;
  const fetchImpl = params.fetchImpl ?? ((input, init) => fetch(input, init));
  let version = params.version;
  // The last write, once leave() asked for it: its text, the signal that
  // aborts it, and whether it went out as a keepalive request.
  let last: { text: string; signal: AbortSignal; keepalive: boolean } | null = null;

  const queue = createSaveQueue(params.markdown, async (text) => {
    if (!(await lock.ensure())) {
      const { phase, holderName } = lock.getState();
      throw new Error(phase === "elsewhere" ? EDITING_ELSEWHERE : editingMessage(holderName));
    }
    const leaving = last !== null && text === last.text ? last : null;
    const request = JSON.stringify({
      markdown: text,
      version,
      session: lock.session,
      ...(leaving ? { release: true } : {}),
    });
    const res = await fetchImpl(`/api/notes/${encodeURIComponent(docId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: request,
      ...(leaving ? leaveOptions(leaving, request) : {}),
    });
    const payload: unknown = await res.json().catch(() => null);
    const body = (payload && typeof payload === "object" ? payload : {}) as {
      version?: unknown;
      error?: unknown;
    };
    if (res.ok && typeof body.version === "number") {
      version = body.version;
      return;
    }
    if (res.status === 409) onConflict();
    if (res.status === 423) void lock.refresh();
    throw new Error(typeof body.error === "string" ? body.error : `Could not save (${res.status})`);
  });

  return {
    queue,
    get version() {
      return version;
    },
    setVersion(next) {
      version = next;
    },
    leave(text) {
      const abort = new AbortController();
      const leaving = { text, signal: abort.signal, keepalive: false };
      last = leaving;
      const timedOut = new Promise<never>((_, reject) => {
        abort.signal.addEventListener("abort", () => reject(new Error("The last save did not finish in time")));
      });
      const timer = setTimeout(() => abort.abort(), params.leaveTimeoutMs ?? LEAVE_TIMEOUT_MS);
      const done = Promise.race([queue.save(text), timedOut]).finally(() => clearTimeout(timer));
      return { done, outlivesPage: () => leaving.keepalive };
    },
  };
}
