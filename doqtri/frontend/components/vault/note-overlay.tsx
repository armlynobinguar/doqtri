"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isServerReachable, NoResponseError } from "@/lib/no-response";

/*
 * Vault actions used to wait for two round trips before the screen changed:
 * the API call, then router.refresh() re-running the layout (the explorer's
 * notes) and the page (every note's text, for the tab, graph and mindmap).
 * The overlay is what the client shows in the meantime: the changes it has
 * asked for and not yet seen in server data, laid over whatever the server
 * last rendered.
 *
 * It is plain state, one entry per pending change, and deliberately not
 * useOptimistic. An optimistic update lasts only while its async transition
 * runs, and while any async transition runs React puts every other
 * transition in its lane: each router push, refresh and back/forward would
 * wait for the rename or delete in flight. Here the request runs outside any
 * transition, so navigation never waits on it.
 *
 * An entry goes away in one of three ways:
 * - the request is refused: that entry alone is dropped, so the old title or
 *   row comes back while other changes stay;
 * - server data shows the change (the layout's notes have the new title, or
 *   no longer have the note; the failed import is gone), or for an accepted
 *   rename, shows any title but the old one (a teammate renamed it after
 *   us): it is no longer needed, and dropping it on that same render means
 *   no frame shows the old value;
 * - it was confirmed but server data has not shown it for CONFIRMED_TTL_MS:
 *   a fallback, so an entry whose refresh got lost cannot pin a title for
 *   good.
 *
 * The refreshes that bring that server data are scheduled with care; see
 * useNoteOverlayState.
 */

/** One pending change. `confirmedAt` is set when the server accepted it. */
type Pending = { token: number; confirmedAt: number | null };

/** What the client has asked the server for and not yet seen back. */
export type NoteOverlay = {
  /** Note id → the title it is being renamed to, and the one it had. */
  titles: ReadonlyMap<string, Pending & { title: string; previousTitle: string }>;
  /** Notes being deleted. */
  deleted: ReadonlyMap<string, Pending>;
  /** Failed imports (ingest ids) being dismissed. */
  dismissed: ReadonlyMap<string, Pending>;
};

export type NoteChange =
  | { kind: "rename"; id: string; title: string; previousTitle: string }
  | { kind: "delete"; id: string }
  | { kind: "dismiss"; id: string };

export const EMPTY_OVERLAY: NoteOverlay = {
  titles: new Map(),
  deleted: new Map(),
  dismissed: new Map(),
};

/** How long a confirmed change may wait for server data to show it. */
export const CONFIRMED_TTL_MS = 20_000;

const FIELD = { rename: "titles", delete: "deleted", dismiss: "dismissed" } as const;

/** The overlay with one more change on it, under `token`. Never mutates `overlay`. */
export function applyChange(overlay: NoteOverlay, change: NoteChange, token: number): NoteOverlay {
  const pending: Pending = { token, confirmedAt: null };
  switch (change.kind) {
    case "rename":
      return {
        ...overlay,
        titles: new Map(overlay.titles).set(change.id, {
          ...pending,
          title: change.title,
          previousTitle: change.previousTitle,
        }),
      };
    case "delete":
      return { ...overlay, deleted: new Map(overlay.deleted).set(change.id, pending) };
    case "dismiss":
      return { ...overlay, dismissed: new Map(overlay.dismissed).set(change.id, pending) };
  }
}

/** Without the entry `token` put there; the same overlay if it is gone already. */
export function dropChange(overlay: NoteOverlay, change: NoteChange, token: number): NoteOverlay {
  const field = FIELD[change.kind];
  const map: ReadonlyMap<string, Pending> = overlay[field];
  if (map.get(change.id)?.token !== token) return overlay;
  const next = new Map(map);
  next.delete(change.id);
  return { ...overlay, [field]: next };
}

/** Marks the entry `token` put there as accepted by the server at `now`. */
export function confirmChange(overlay: NoteOverlay, change: NoteChange, token: number, now: number): NoteOverlay {
  const field = FIELD[change.kind];
  const map: ReadonlyMap<string, Pending> = overlay[field];
  const entry = map.get(change.id);
  if (entry?.token !== token) return overlay;
  return { ...overlay, [field]: new Map(map).set(change.id, { ...entry, confirmedAt: now }) };
}

function prune<T extends Pending>(
  map: ReadonlyMap<string, T>,
  done: (id: string, entry: T) => boolean,
): ReadonlyMap<string, T> {
  let next: Map<string, T> | null = null;
  for (const [id, entry] of map) {
    if (!done(id, entry)) continue;
    next ??= new Map(map);
    next.delete(id);
  }
  return next ?? map;
}

function rebuilt(overlay: NoteOverlay, parts: NoteOverlay): NoteOverlay {
  return parts.titles === overlay.titles && parts.deleted === overlay.deleted && parts.dismissed === overlay.dismissed
    ? overlay
    : parts;
}

/**
 * Without the entries server data already shows: a rename once the note has
 * that title (or is gone), or once accepted, any title but the one it had; a
 * delete once the note is gone; a dismissal once the failed import is gone.
 * The same overlay when there are none.
 */
export function settleOverlay(
  overlay: NoteOverlay,
  notes: { id: string; title: string }[],
  failedImports: { id: string }[],
): NoteOverlay {
  if (overlay === EMPTY_OVERLAY) return overlay;
  const titles = new Map(notes.map((note) => [note.id, note.title]));
  const imports = new Set(failedImports.map((item) => item.id));
  return rebuilt(overlay, {
    titles: prune(overlay.titles, (id, entry) => {
      const title = titles.get(id);
      if (title === undefined || title === entry.title) return true;
      // Accepted, and the server has moved on from the old title: to ours,
      // or to a teammate's since, which is the one to show.
      return entry.confirmedAt !== null && title !== entry.previousTitle;
    }),
    deleted: prune(overlay.deleted, (id) => !titles.has(id)),
    dismissed: prune(overlay.dismissed, (id) => !imports.has(id)),
  });
}

/** Without confirmed entries that have waited `ttl` or longer for server data. */
export function expireOverlay(overlay: NoteOverlay, now: number, ttl = CONFIRMED_TTL_MS): NoteOverlay {
  const expired = (_: string, entry: Pending) => entry.confirmedAt !== null && now - entry.confirmedAt >= ttl;
  return rebuilt(overlay, {
    titles: prune(overlay.titles, expired),
    deleted: prune(overlay.deleted, expired),
    dismissed: prune(overlay.dismissed, expired),
  });
}

function confirmedTimes(overlay: NoteOverlay): number[] {
  return [...overlay.titles.values(), ...overlay.deleted.values(), ...overlay.dismissed.values()]
    .map((entry) => entry.confirmedAt)
    .filter((at): at is number => at !== null);
}

/**
 * Notes (or docs) as the overlay says they will be: pending renames applied,
 * pending deletes left out, order unchanged. Hands back `items` itself when
 * the overlay touches none of them, so memoized consumers do not recompute.
 */
export function overlayNotes<T extends { id: string; title: string }>(
  items: T[],
  overlay: NoteOverlay,
): T[] {
  if (overlay.titles.size === 0 && overlay.deleted.size === 0) return items;
  const touched = items.some((item) => overlay.titles.has(item.id) || overlay.deleted.has(item.id));
  if (!touched) return items;
  return items
    .filter((item) => !overlay.deleted.has(item.id))
    .map((item) => {
      const title = overlay.titles.get(item.id)?.title;
      return title === undefined || title === item.title ? item : { ...item, title };
    });
}

/**
 * Whether a rename or delete of this note has not yet shown in server data.
 * Its row offers neither until then, so a second one cannot race the first.
 */
export function isNotePending(overlay: NoteOverlay, id: string): boolean {
  return overlay.titles.has(id) || overlay.deleted.has(id);
}

export type RunChange = (
  change: NoteChange,
  action: () => Promise<void>,
  onError: (error: unknown) => void,
) => void;

/**
 * The titles being typed into notes' title lines (DOQ-44): display labels
 * only. They are kept apart from the overlay, so nothing but the labels sees
 * them: not the notes' data (graph links, backlinks, the ship panel), not
 * isTitleTaken, not isNotePending. Each label reads its own note's entry
 * (useDraftTitle), so a keystroke re-renders the labels of that note and
 * nothing else. A rename typed this way that lands becomes an ordinary
 * accepted rename in the overlay (NoteTitleDrafts.landed); its draft goes
 * once that shows, so no frame shows the old title.
 */
export function createDraftStore() {
  const drafts = new Map<string, string>();
  // Drafts whose editor is gone, with nothing more on its way: they go at the next prune.
  const settling = new Set<string>();
  const listeners = new Set<() => void>();
  function set(id: string, title: string | null) {
    settling.delete(id);
    if ((title ?? undefined) === drafts.get(id)) return;
    if (title === null) drafts.delete(id);
    else drafts.set(id, title);
    for (const listener of listeners) listener();
  }
  return {
    get: (id: string): string | undefined => drafts.get(id),
    /** The label to show for note `id`, or with null, none. */
    set,
    /** Drops note `id`'s draft at the next prune, once what landed shows instead. */
    settle(id: string) {
      if (drafts.has(id)) settling.add(id);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Without the drafts the notes already show under that title, and those settling. */
    prune(shown: (id: string) => string | undefined) {
      for (const [id, title] of drafts) if (settling.has(id) || shown(id) === title) set(id, null);
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

/** Drafts and what a heading rename typed in the editor needs from the overlay (DOQ-44). */
export type NoteTitleDrafts = {
  drafts: DraftStore;
  /** A rename made from the title line landed: shown as an accepted rename, and a refresh asked for. */
  landed(change: { id: string; title: string; previousTitle: string }): void;
  /** Asks for a refresh through the scheduler, never router.refresh() directly. */
  refresh(): void;
  /** Drops note `id`'s draft after the next commit, once whatever landed shows (DraftStore.settle). */
  settle(id: string): void;
};

/** How long a refresh may take before another may start regardless. */
export const REFRESH_WAIT_MS = 10_000;

/**
 * Decides when router.refresh() may run; see useNoteOverlayState. Plain code,
 * not hooks: its state is a few flags that no render reads.
 */
export type RefreshEnv = {
  refresh: () => void;
  isNavigating: () => boolean;
  isOffline: () => boolean;
  /** Whether the server answers; asked before refreshing after a lost answer. */
  probe: () => Promise<boolean>;
};

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function createRefreshScheduler(initial: RefreshEnv) {
  let env = initial;
  let wanted = false;
  let inFlight = false;
  // A request got no answer since server data last arrived: the server may
  // be unreachable even though the browser says it is online.
  let unverified = false;
  let probing = false;
  let giveUp: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    if (!wanted || inFlight || probing || env.isNavigating() || env.isOffline()) return;
    if (unverified) {
      probing = true;
      void env
        .probe()
        .catch(() => false)
        .then((reachable) => {
          probing = false;
          // Unreachable: keep waiting for the next chance, and ask again then.
          if (!reachable) return;
          unverified = false;
          flush();
        });
      return;
    }
    wanted = false;
    inFlight = true;
    clearTimeout(giveUp);
    // A refresh that never shows up (lost some way not seen here) must not
    // block every later one.
    giveUp = setTimeout(settled, REFRESH_WAIT_MS);
    env.refresh();
  }

  /** The refresh out, if any, is over: new server data came, or a navigation replaced it. */
  function settled() {
    inFlight = false;
    clearTimeout(giveUp);
    flush();
  }

  return {
    /** Swaps in the latest callbacks; the flags stay. */
    setEnv(next: RefreshEnv) {
      env = next;
    },
    /** Asks for a refresh: now if `now` and it is safe, else at the next chance. */
    want(now: boolean) {
      wanted = true;
      if (now) flush();
    },
    /** A request was answered: the server answers, whatever an earlier one met. */
    answered() {
      unverified = false;
    },
    /**
     * Asks for a refresh after a request got no answer: at the next chance,
     * once the server is seen to answer.
     */
    wantAfterNoAnswer() {
      wanted = true;
      unverified = true;
    },
    settled,
    /** New server data arrived: the server answers, and the refresh out is over. */
    serverData() {
      unverified = false;
      settled();
    },
    /** A chance to run one that was asked for: back online, back in view. */
    flush,
    dispose() {
      clearTimeout(giveUp);
    },
  };
}

/**
 * Owns the overlay; the vault shell calls it once and provides the result.
 *
 * `notes` and `failedImports` are the layout's server data, which entries are
 * settled against. `run` applies `change` at once and calls `action` (the API
 * request) outside any transition. When it resolves, the entry is confirmed
 * and a refresh is asked for, to bring the server data that settles it. When
 * it throws, that entry alone is dropped and `onError` gets the error.
 *
 * Refreshes (`refresh` is router.refresh) are only asked for, and run when
 * that is safe:
 * - never while a vault navigation is under way (`navigating`,
 *   `isNavigating`): Next would run the refresh in the same batch as the
 *   push, and the page would not change until it came back. One asked for
 *   meanwhile runs once the navigation commits;
 * - never while the browser says it is offline: a refresh that cannot reach
 *   the server makes Next reload the whole page, losing unsaved text. It
 *   runs on the `online` event instead;
 * - one at a time: a refresh counts as done when new server data arrives or
 *   a navigation commits (which may have discarded it), and one asked for
 *   meanwhile runs after.
 *
 * A request that got no answer may still have done its work, but asking for
 * a refresh at once would likely fail the same way. It is left until the
 * next navigation commits, the tab comes back into view, or the browser
 * comes back online, and even then runs only once a cheap request shows the
 * server answering. And after each navigation (`location` is the pathname),
 * while accepted changes still wait, the refresh is asked for again, since
 * the navigation may have discarded the earlier one.
 */
export function useNoteOverlayState({
  notes,
  failedImports,
  location,
  navigating,
  isNavigating,
  refresh,
}: {
  notes: { id: string; title: string }[];
  failedImports: { id: string }[];
  location: string;
  navigating: boolean;
  isNavigating: () => boolean;
  refresh: () => void;
}): { overlay: NoteOverlay; run: RunChange; titleDrafts: NoteTitleDrafts } {
  const [raw, setRaw] = useState(EMPTY_OVERLAY);
  const overlay = useMemo(() => settleOverlay(raw, notes, failedImports), [raw, notes, failedImports]);
  // Settled entries leave the state on this same render, so one cannot
  // linger and later cover a title that changed again on the server.
  if (overlay !== raw) setRaw(overlay);

  // Made once; its callbacks are swapped in after each change to them. No
  // request can answer before the first effect runs, so none is missed.
  const [scheduler] = useState(() =>
    createRefreshScheduler({ refresh: () => {}, isNavigating: () => true, isOffline, probe: isServerReachable }),
  );
  useEffect(() => {
    scheduler.setEnv({ refresh, isNavigating, isOffline, probe: isServerReachable });
  }, [scheduler, refresh, isNavigating]);

  const [drafts] = useState(createDraftStore);
  const nextToken = useRef(0);
  const run = useCallback<RunChange>(
    (change, action, onError) => {
      const token = ++nextToken.current;
      setRaw((prev) => applyChange(prev, change, token));
      // A rename from the explorer replaces any title being typed into the
      // note's title line: the new title shows at once, not that draft (DOQ-46).
      if (change.kind === "rename") drafts.set(change.id, null);
      void (async () => {
        try {
          await action();
        } catch (error) {
          setRaw((prev) => dropChange(prev, change, token));
          onError(error);
          // Not now: see above.
          if (error instanceof NoResponseError) scheduler.wantAfterNoAnswer();
          // A refusal is an answer too.
          else scheduler.answered();
          return;
        }
        setRaw((prev) => confirmChange(prev, change, token, Date.now()));
        scheduler.answered();
        scheduler.want(true);
      })();
    },
    [drafts, scheduler],
  );

  // Bumped by `settle`, so the prune below runs after the commit that shows what landed.
  const [settles, setSettles] = useState(0);
  const titleDrafts = useMemo<NoteTitleDrafts>(
    () => ({
      drafts,
      landed(change) {
        const rename = { kind: "rename" as const, ...change };
        const token = ++nextToken.current;
        const now = Date.now();
        setRaw((prev) => {
          // A rename from the explorer still on its way is the later word
          // (DOQ-46): this one, answered after it was made, does not cover it.
          if (prev.titles.get(change.id)?.confirmedAt === null) return prev;
          return confirmChange(applyChange(prev, rename, token), rename, token, now);
        });
        scheduler.answered();
        scheduler.want(true);
      },
      refresh() {
        scheduler.want(true);
      },
      settle(id) {
        drafts.settle(id);
        setSettles((count) => count + 1);
      },
    }),
    [drafts, scheduler],
  );
  // A draft goes once the note shows that title: after this commit, so the
  // label never falls back to an older one in between.
  useEffect(() => {
    const titles = new Map(notes.map((note) => [note.id, note.title]));
    drafts.prune((id) => overlay.titles.get(id)?.title ?? titles.get(id));
  }, [drafts, overlay, notes, settles]);

  // New server data: the refresh out, if any, is done.
  useEffect(() => {
    scheduler.serverData();
  }, [notes, failedImports, scheduler]);

  const latest = useRef(overlay);
  useEffect(() => {
    latest.current = overlay;
  }, [overlay]);

  // A navigation committed: it may have discarded the refresh out, so ask
  // again while accepted changes wait, and run whatever waited for it.
  const lastLocation = useRef(location);
  useEffect(() => {
    if (navigating) return;
    if (lastLocation.current !== location && confirmedTimes(latest.current).length > 0) scheduler.want(false);
    lastLocation.current = location;
    scheduler.settled();
  }, [location, navigating, scheduler]);

  // Back online, or back in view: run a refresh that waited for it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduler.flush();
    };
    window.addEventListener("online", scheduler.flush);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", scheduler.flush);
      document.removeEventListener("visibilitychange", onVisible);
      scheduler.dispose();
    };
  }, [scheduler]);

  // The fallback for a confirmed entry that server data never shows.
  useEffect(() => {
    const times = confirmedTimes(overlay);
    if (times.length === 0) return;
    const wait = Math.max(0, Math.min(...times) + CONFIRMED_TTL_MS - Date.now());
    const timer = setTimeout(() => setRaw((prev) => expireOverlay(prev, Date.now())), wait);
    return () => clearTimeout(timer);
  }, [overlay]);

  return { overlay, run, titleDrafts };
}

const NoteOverlayContext = createContext<NoteOverlay>(EMPTY_OVERLAY);

export const NoteOverlayProvider = NoteOverlayContext.Provider;

/** The vault's pending changes; empty outside the vault shell. */
export function useNoteOverlay(): NoteOverlay {
  return useContext(NoteOverlayContext);
}

/** Notes or docs from server data, with the vault's pending renames and deletes applied. */
export function useOverlaidNotes<T extends { id: string; title: string }>(items: T[]): T[] {
  const overlay = useNoteOverlay();
  return useMemo(() => overlayNotes(items, overlay), [items, overlay]);
}

/** A note's title, or the one it is being renamed to. */
export function useNoteTitle(id: string, title: string): string {
  return useNoteOverlay().titles.get(id)?.title ?? title;
}

const NoteTitleDraftsContext = createContext<NoteTitleDrafts>({
  drafts: createDraftStore(),
  landed() {},
  refresh() {},
  settle() {},
});

export const NoteTitleDraftsProvider = NoteTitleDraftsContext.Provider;

export function useNoteTitleDrafts(): NoteTitleDrafts {
  return useContext(NoteTitleDraftsContext);
}

/**
 * The label for note `id`: the title being typed into its title line
 * (DOQ-44), else `title`. Re-renders only when that note's draft changes.
 */
export function useDraftTitle(id: string | undefined, title: string): string {
  const { drafts } = useNoteTitleDrafts();
  const get = () => (id === undefined ? undefined : drafts.get(id));
  return useSyncExternalStore(drafts.subscribe, get, get) ?? title;
}
