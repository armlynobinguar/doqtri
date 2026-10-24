import { createSaveQueue, type SaveQueue } from "@/lib/save-queue";
import { editingMessage } from "@/lib/doc-lock";
import type { DocLockController } from "@/lib/doc-lock-client";

/**
 * The editor's save path (WP-1.6, D-17): a save queue whose writes hold the
 * edit lock and go to PUT /api/notes/[id] with the version the text is based
 * on, keeping that version current as saves land.
 *
 *   no lock to be had     the write fails; nothing is sent
 *   423 (lock lost)       the lock status is re-read, so the editor goes
 *                         read-only and names the holder
 *   409 (stale version)   `onConflict` is called; the editor must reload
 *                         before saving again, and nothing is overwritten
 */
export type NoteSaver = {
  queue: SaveQueue;
  /** The save version the stored text is at, as far as this editor knows. */
  readonly version: number;
  /** Adopts `version`, for text loaded or written elsewhere (reload, regenerate). */
  setVersion(version: number): void;
};

export function createNoteSaver(params: {
  docId: string;
  markdown: string;
  version: number;
  lock: Pick<DocLockController, "ensure" | "refresh" | "getState">;
  onConflict: () => void;
  fetchImpl?: typeof fetch;
}): NoteSaver {
  const { docId, lock, onConflict } = params;
  const fetchImpl = params.fetchImpl ?? ((input, init) => fetch(input, init));
  let version = params.version;

  const queue = createSaveQueue(params.markdown, async (text) => {
    if (!(await lock.ensure())) {
      throw new Error(editingMessage(lock.getState().holderName));
    }
    const res = await fetchImpl(`/api/notes/${encodeURIComponent(docId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: text, version }),
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
  };
}
