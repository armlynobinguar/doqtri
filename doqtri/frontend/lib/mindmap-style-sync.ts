import { parseStyle, type MindmapStyle } from "@/lib/mindmap-style";

/**
 * Where a map's studio style lives: in memory while the page is open, in the
 * signed-in user's `mindmap_styles` row for good, and in this browser only as
 * a stopgap for edits the server has not confirmed yet.
 *
 * The store keeps the in-memory style as the thing the canvas renders, so a
 * slider drag never waits on the network. Saving trails the last change by a
 * moment; until a save lands, the edit is also parked in browser storage, so
 * closing the tab mid-wait, a dropped connection or a failed request loses
 * nothing — the next visit picks it up and sends it again.
 *
 * Maps nobody is signed in for (the demo vault) skip all of that and keep the
 * style in browser storage, as every map did before styles were saved per user.
 */

/** The user's stored style for one map, as the server page loaded it. */
export type SavedStyle = {
  userId: string;
  /** The row's style, not yet parsed; null when the user never restyled this map. */
  style: unknown;
  /** The row's server timestamp, which works as its version; null with no row. */
  updatedAt: string | null;
  /** False when the row could not be read, so whether one exists is unknown. */
  loaded: boolean;
};

/** An edit not yet confirmed by the server, and the version it was made on. */
type Pending = { style: unknown; base: string | null };

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StyleStoreDeps = {
  /** Browser storage; may be missing or throw (private windows, blocked site data). */
  storage: () => KeyValueStorage | null;
  /** Upserts the style and resolves with the row's new `updated_at`. */
  save: (row: { userId: string; scope: string; style: MindmapStyle }) => Promise<string>;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** How long after the last change a save goes out. */
  delayMs?: number;
};

/** The browser-only style, and before per-user saving, every map's style. */
export const LOCAL_PREFIX = "mindmap-style:";
const PENDING_PREFIX = "mindmap-style-pending:";

const SAVE_DELAY_MS = 600;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** Failed saves retry while the page is open; the parked edit outlives them. */
const MAX_ATTEMPTS = 6;

type Remote = {
  userId: string;
  scope: string;
  /** The server version this style was last in sync with. */
  base: string | null;
  /** Bumped on every change, so a save knows whether it sent the latest. */
  revision: number;
  savedRevision: number;
  saving: boolean;
  failures: number;
  timer: unknown;
};

type Entry = { style: MindmapStyle; remote: Remote | null };

/** Two styles look the same once both are normalised the same way. */
export function sameStyle(a: MindmapStyle, b: MindmapStyle): boolean {
  return JSON.stringify(parseStyle(a, b)) === JSON.stringify(parseStyle(b, b));
}

function parseJson(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parsePending(raw: string | null): Pending | null {
  const value = parseJson(raw);
  if (!value || typeof value !== "object") return null;
  const { style, base } = value as Record<string, unknown>;
  if (!style || typeof style !== "object") return null;
  return { style, base: typeof base === "string" ? base : null };
}

function isNewer(candidate: string | null, than: string | null): boolean {
  if (!candidate) return false;
  if (!than) return true;
  return Date.parse(candidate) > Date.parse(than);
}

export function createStyleStore(deps: StyleStoreDeps) {
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const delayMs = deps.delayMs ?? SAVE_DELAY_MS;

  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();

  function storage(): KeyValueStorage | null {
    try {
      return deps.storage();
    } catch {
      return null;
    }
  }

  function get(key: string): string | null {
    try {
      return storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  function set(key: string, value: string) {
    try {
      storage()?.setItem(key, value);
    } catch {
      // Storage full or blocked: the style still holds for this visit.
    }
  }

  function remove(key: string) {
    try {
      storage()?.removeItem(key);
    } catch {
      // Blocked storage has nothing to remove.
    }
  }

  function keyFor(scope: string, saved?: SavedStyle) {
    return saved ? `${saved.userId}:${scope}` : `local:${scope}`;
  }

  function pendingKey(remote: Remote) {
    return `${PENDING_PREFIX}${remote.userId}:${remote.scope}`;
  }

  function notify() {
    listeners.forEach((listener) => listener());
  }

  /**
   * The style a map opens with, newest first: an edit this browser never got
   * saved, then the user's row, then a style this browser kept from before
   * styles were saved per user — taken over only when there is no row and it
   * actually differs from the default look.
   */
  function open(scope: string, fallback: MindmapStyle, saved: SavedStyle): Entry {
    const remote: Remote = {
      userId: saved.userId,
      scope,
      base: saved.updatedAt,
      revision: 0,
      savedRevision: 0,
      saving: false,
      failures: 0,
      timer: null,
    };

    const pending = parsePending(get(pendingKey(remote)));
    // Another device saved after this edit was made, so its style wins.
    const pendingIsCurrent = pending && (!saved.loaded || pending.base === saved.updatedAt);
    if (pending && !pendingIsCurrent) remove(pendingKey(remote));

    let style: MindmapStyle;
    let upload = false;
    if (pending && pendingIsCurrent) {
      style = parseStyle(pending.style, fallback);
      upload = true;
    } else if (saved.style != null) {
      style = parseStyle(saved.style, fallback);
    } else {
      style = fallback;
      // Without the row there is no telling whether it exists, so an old
      // browser style must not overwrite it; it waits for the next visit.
      if (saved.loaded) {
        const local = parseJson(get(LOCAL_PREFIX + scope));
        if (local !== undefined) {
          const kept = parseStyle(local, fallback);
          if (!sameStyle(kept, fallback)) {
            style = kept;
            upload = true;
          }
          remove(LOCAL_PREFIX + scope);
        }
      }
    }

    if (saved.style != null && saved.loaded) remove(LOCAL_PREFIX + scope);

    const entry: Entry = { style, remote };
    if (upload) {
      remote.revision = 1;
      park(entry);
    }
    return entry;
  }

  function park(entry: Entry) {
    const remote = entry.remote!;
    set(pendingKey(remote), JSON.stringify({ style: entry.style, base: remote.base }));
  }

  function schedule(entry: Entry, ms: number) {
    const remote = entry.remote!;
    if (remote.timer !== null) clearTimer(remote.timer);
    remote.timer = setTimer(() => {
      remote.timer = null;
      void push(entry);
    }, ms);
  }

  async function push(entry: Entry) {
    const remote = entry.remote!;
    if (remote.saving || remote.revision === remote.savedRevision) return;
    remote.saving = true;
    const revision = remote.revision;
    try {
      remote.base = await deps.save({ userId: remote.userId, scope: remote.scope, style: entry.style });
      remote.savedRevision = revision;
      remote.failures = 0;
    } catch {
      remote.failures += 1;
    } finally {
      remote.saving = false;
    }

    if (remote.revision === remote.savedRevision) {
      remove(pendingKey(remote));
    } else if (remote.failures === 0) {
      // Changed while the save was out: park against the new version, send again.
      park(entry);
      schedule(entry, delayMs);
    } else if (remote.failures < MAX_ATTEMPTS) {
      schedule(entry, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (remote.failures - 1)));
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    read(scope: string, fallback: MindmapStyle, saved?: SavedStyle): MindmapStyle {
      const key = keyFor(scope, saved);
      const entry = entries.get(key);

      if (entry) {
        // Back on a map opened earlier in this tab: take a newer version the
        // server page brought, unless there are edits here still to send.
        const remote = entry.remote;
        if (
          saved?.loaded &&
          remote &&
          remote.revision === remote.savedRevision &&
          !remote.saving &&
          isNewer(saved.updatedAt, remote.base)
        ) {
          entry.style = saved.style != null ? parseStyle(saved.style, fallback) : fallback;
          remote.base = saved.updatedAt;
        }
        return entry.style;
      }

      let created: Entry;
      if (saved) {
        created = open(scope, fallback, saved);
      } else {
        const local = parseJson(get(LOCAL_PREFIX + scope));
        created = { style: local !== undefined ? parseStyle(local, fallback) : fallback, remote: null };
      }
      entries.set(key, created);
      return created.style;
    },

    write(scope: string, style: MindmapStyle, saved?: SavedStyle) {
      const entry = entries.get(keyFor(scope, saved));
      if (!entry) return;
      entry.style = style;

      if (entry.remote) {
        entry.remote.revision += 1;
        entry.remote.failures = 0;
        park(entry);
        schedule(entry, delayMs);
      } else {
        set(LOCAL_PREFIX + scope, JSON.stringify(style));
      }
      notify();
    },

    /** Sends an opened map's style if it still has edits the server lacks. */
    resume(scope: string, saved?: SavedStyle) {
      const entry = entries.get(keyFor(scope, saved));
      const remote = entry?.remote;
      if (!entry || !remote || remote.revision === remote.savedRevision) return;
      if (remote.timer === null && !remote.saving) schedule(entry, delayMs);
    },

    /** Sends every waiting edit now, for when the page is going away. */
    flush() {
      for (const entry of entries.values()) {
        const remote = entry.remote;
        if (!remote || remote.revision === remote.savedRevision || remote.saving) continue;
        if (remote.timer !== null) clearTimer(remote.timer);
        remote.timer = null;
        void push(entry);
      }
    },
  };
}

export type StyleStore = ReturnType<typeof createStyleStore>;
