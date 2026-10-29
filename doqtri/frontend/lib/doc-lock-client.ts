import {
  DOC_LOCK_HEARTBEAT_MS,
  DOC_LOCK_IDLE_MS,
  DOC_LOCK_POLL_MS,
  newEditSession,
  readDocLockStatus,
  type DocLockStatus,
} from "@/lib/doc-lock";

/**
 * The editor's side of edit locking (WP-1.6, D-17), without React, so it can
 * be driven by fake timers in tests. hooks/use-doc-lock.ts wraps it.
 *
 * Opening a note takes nothing: the lock is taken on the first edit
 * (`noteEdit()`), renewed every minute that saw an edit, and released when the
 * editor has been idle for ten minutes or the note is left (`stop()`). While
 * someone else holds it, the status is polled so the editor learns when they
 * finish, and when they saved, so it can load their text.
 *
 * The lock belongs to one edit session, not just one user: each controller
 * has its own session id (lib/doc-lock.ts), which the API names on every
 * call. A second tab of the same user therefore sees the lock as held
 * elsewhere ("elsewhere"), goes read-only, and can neither renew, save under
 * nor release the first tab's lock; it may take it over on purpose.
 */

export type DocLockPhase =
  /** Status not known yet. */
  | "loading"
  /** Nobody holds it: the editor is editable and takes it on the first edit. */
  | "free"
  /** A take is in flight. */
  | "taking"
  /** The caller holds it. */
  | "mine"
  /** Someone else holds it: read-only. */
  | "other"
  /** The caller holds it from another tab or device: read-only here. */
  | "elsewhere";

export type DocLockState = {
  phase: DocLockPhase;
  holderName: string | null;
  canEdit: boolean;
  canTakeOver: boolean;
  /** The note's save version as of the last status, or null before the first. */
  version: number | null;
  /** The last request failed; the controller keeps retrying on its schedule. */
  error: string | null;
};

/** What the controller calls; `createDocLockApi()` is the real one. */
export type DocLockApi = {
  /** The edit session every call names. */
  readonly session: string;
  status(): Promise<DocLockStatus>;
  /** Resolves with the status after the attempt; `mine` says whether it worked. */
  take(takeover: boolean): Promise<DocLockStatus>;
  /** `keepalive` lets the request outlive the page, for unload. */
  release(options?: { keepalive?: boolean }): Promise<void>;
};

export type DocLockTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
};

const realTimers: DocLockTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type DocLockController = {
  /** This editor's edit session, for saves and other writes that need the lock. */
  readonly session: string;
  getState(): DocLockState;
  subscribe(listener: () => void): () => void;
  /** Loads the status and starts the schedule. */
  start(): void;
  /**
   * Records an edit. Takes the lock when it is free; resolves with whether
   * the caller holds it afterwards.
   */
  noteEdit(): Promise<boolean>;
  /**
   * Holds the lock before a save or regenerate: takes it if free. Counts as
   * activity, so the idle timer starts over.
   */
  ensure(): Promise<boolean>;
  /**
   * Takes the lock from whoever holds it: admins and owners, or anyone who
   * can edit when it is their own lock in another tab.
   */
  takeOver(): Promise<boolean>;
  /** Re-reads the status now, e.g. after a save was refused. */
  refresh(): Promise<void>;
  /** Stops the schedule and releases the lock if held. Safe to call twice. */
  stop(options?: { keepalive?: boolean }): void;
  /** Replaces the status and lost-lock callbacks. */
  setHandlers(handlers: DocLockHandlers): void;
};

export type DocLockHandlers = {
  /** Called with every status received, so the editor can compare versions. */
  onStatus?: (status: DocLockStatus) => void;
  /** Called when a lock this editor held turns out to be someone else's, or another tab's. */
  onLost?: (status: DocLockStatus) => void;
};

export function createDocLockController(params: {
  api: DocLockApi;
  timers?: DocLockTimers;
  heartbeatMs?: number;
  idleMs?: number;
  pollMs?: number;
} & DocLockHandlers): DocLockController {
  const { api } = params;
  let handlers: DocLockHandlers = { onStatus: params.onStatus, onLost: params.onLost };
  const timers = params.timers ?? realTimers;
  const heartbeatMs = params.heartbeatMs ?? DOC_LOCK_HEARTBEAT_MS;
  const idleMs = params.idleMs ?? DOC_LOCK_IDLE_MS;
  const pollMs = params.pollMs ?? DOC_LOCK_POLL_MS;

  let state: DocLockState = {
    phase: "loading",
    holderName: null,
    canEdit: false,
    canTakeOver: false,
    version: null,
    error: null,
  };
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let stopped = false;
  let lastEdit = 0;
  let editedSinceBeat = false;
  let inflight: Promise<boolean> | null = null;

  function set(next: Partial<DocLockState>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  function apply(status: DocLockStatus) {
    const wasMine = state.phase === "mine";
    const phase: DocLockPhase = status.mine
      ? "mine"
      : status.mineElsewhere
        ? "elsewhere"
        : status.holder
          ? "other"
          : "free";
    set({
      phase,
      holderName: phase === "other" ? status.holderName : null,
      canEdit: status.canEdit,
      canTakeOver: status.canTakeOver,
      version: status.version,
      error: null,
    });
    handlers.onStatus?.(status);
    if (wasMine && (phase === "other" || phase === "elsewhere")) handlers.onLost?.(status);
  }

  function fail(e: unknown) {
    set({ error: e instanceof Error ? e.message : "Could not reach the server" });
  }

  function schedule() {
    if (stopped) return;
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(tick, state.phase === "mine" ? heartbeatMs : pollMs);
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    try {
      if (state.phase === "mine") {
        if (editedSinceBeat) {
          editedSinceBeat = false;
          apply(await api.take(false));
        } else if (timers.now() - lastEdit >= idleMs) {
          // Idle for the whole timeout: let others in rather than wait for
          // the server to notice.
          await api.release();
          if (!stopped) await refreshStatus();
        }
      } else if (state.phase !== "taking") {
        await refreshStatus();
      }
    } catch (e) {
      fail(e);
    }
    schedule();
  }

  async function refreshStatus() {
    apply(await api.status());
  }

  async function take(takeover: boolean): Promise<boolean> {
    if (stopped) return false;
    if (inflight) return inflight;
    const before = state.phase;
    set({ phase: "taking" });
    inflight = (async () => {
      try {
        apply(await api.take(takeover));
      } catch (e) {
        set({ phase: before === "taking" ? "free" : before });
        fail(e);
      } finally {
        inflight = null;
      }
      schedule();
      return state.phase === "mine";
    })();
    return inflight;
  }

  return {
    session: api.session,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      stopped = false;
      // The idle timer counts from opening (or coming back to) the note, not
      // from the epoch: a status that says the lock is already this
      // session's must not read as ten idle minutes.
      lastEdit = timers.now();
      editedSinceBeat = false;
      if (state.phase !== "loading") set({ phase: "loading" });
      void refreshStatus()
        .catch((e) => {
          set({ phase: "free" });
          fail(e);
        })
        .finally(schedule);
    },
    async noteEdit() {
      lastEdit = timers.now();
      editedSinceBeat = true;
      if (state.phase === "mine") return true;
      if (state.phase === "taking" && inflight) return inflight;
      if (state.phase === "other" || state.phase === "elsewhere" || !state.canEdit) return false;
      return take(false);
    },
    async ensure() {
      lastEdit = timers.now();
      if (state.phase === "mine") return true;
      if (inflight) return inflight;
      if (!state.canEdit || state.phase === "other" || state.phase === "elsewhere") return false;
      return take(false);
    },
    async takeOver() {
      const ownElsewhere = state.phase === "elsewhere" && state.canEdit;
      if (!state.canTakeOver && !ownElsewhere) return false;
      lastEdit = timers.now();
      return take(true);
    },
    async refresh() {
      try {
        await refreshStatus();
      } catch (e) {
        fail(e);
      }
      schedule();
    },
    setHandlers(next) {
      handlers = next;
    },
    stop(options) {
      if (stopped) return;
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      // Only this session's lock is released (the API names the session),
      // so a tab that never held it cannot free another tab's.
      if (state.phase === "mine" || state.phase === "taking") {
        const release = () => api.release({ keepalive: options?.keepalive }).catch(() => {});
        void release();
        // A take still in flight may land after that release: let go again.
        if (inflight) void inflight.then(release, release);
      }
    },
  };
}

async function readLock(res: Response): Promise<DocLockStatus> {
  const payload: unknown = await res.json().catch(() => null);
  const lock =
    payload && typeof payload === "object" && "lock" in payload
      ? readDocLockStatus((payload as { lock: unknown }).lock)
      : null;
  // 423 still carries the status: someone else holds it.
  if (lock && (res.ok || res.status === 423)) return lock;
  const message =
    payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `Lock request failed (${res.status})`;
  throw new Error(message);
}

/**
 * The lock API over /api/notes/[id]/lock, for one edit session (a fresh one
 * unless given).
 */
export function createDocLockApi(
  docId: string,
  fetchImpl: typeof fetch = fetch,
  session: string = newEditSession(),
): DocLockApi {
  const url = `/api/notes/${encodeURIComponent(docId)}/lock?session=${encodeURIComponent(session)}`;
  return {
    session,
    async status() {
      return readLock(await fetchImpl(url, { method: "GET", cache: "no-store" }));
    },
    async take(takeover) {
      return readLock(await fetchImpl(takeover ? `${url}&takeover=1` : url, { method: "POST" }));
    },
    async release(options) {
      await fetchImpl(url, { method: "DELETE", keepalive: options?.keepalive ?? false });
    },
  };
}
