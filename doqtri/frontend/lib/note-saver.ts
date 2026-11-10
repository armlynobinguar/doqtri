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
 * it can (a keepalive request carries at most 64 KiB).
 */
export type NoteSaver = {
  queue: SaveQueue;
  /** The save version the stored text is at, as far as this editor knows. */
  readonly version: number;
  /** Adopts `version`, for text loaded or written elsewhere (reload, regenerate). */
  setVersion(version: number): void;
  /** Saves `text` as the last write, after any in flight; the server then releases the lock. */
  leave(text: string): Promise<void>;
};

/** Bytes, under the browsers' 64 KiB keepalive budget, with room for the headers. */
const KEEPALIVE_BODY_LIMIT = 60_000;

export function createNoteSaver(params: {
  docId: string;
  markdown: string;
  version: number;
  lock: Pick<DocLockController, "session" | "ensure" | "refresh" | "getState">;
  onConflict: () => void;
  fetchImpl?: typeof fetch;
}): NoteSaver {
  const { docId, lock, onConflict } = params;
  const fetchImpl = params.fetchImpl ?? ((input, init) => fetch(input, init));
  let version = params.version;
  // The text of the last write, once leave() asked for it.
  let last: string | null = null;

  const queue = createSaveQueue(params.markdown, async (text) => {
    if (!(await lock.ensure())) {
      const { phase, holderName } = lock.getState();
      throw new Error(phase === "elsewhere" ? EDITING_ELSEWHERE : editingMessage(holderName));
    }
    const leaving = last !== null && text === last;
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
      ...(leaving && new TextEncoder().encode(request).length <= KEEPALIVE_BODY_LIMIT ? { keepalive: true } : {}),
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
      last = text;
      return queue.save(text);
    },
  };
}
