"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NoResponseError } from "@/lib/no-response";

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
 *   no longer have the note; the failed import is gone): it is no longer
 *   needed, and dropping it on that same render means no frame shows the
 *   old value;
 * - it was confirmed but server data has not shown it for CONFIRMED_TTL_MS:
 *   a fallback, so an entry whose refresh got lost cannot pin a title for
 *   good. A navigation can discard a refresh in flight and reuse the cached
 *   layout, so a refresh is issued again after each navigation while
 *   confirmed entries are still waiting.
 */

/** One pending change. `confirmedAt` is set when the server accepted it. */
type Pending = { token: number; confirmedAt: number | null };

/** What the client has asked the server for and not yet seen back. */
export type NoteOverlay = {
  /** Note id → the title it is being renamed to. */
  titles: ReadonlyMap<string, Pending & { title: string }>;
  /** Notes being deleted. */
  deleted: ReadonlyMap<string, Pending>;
  /** Failed imports (ingest ids) being dismissed. */
  dismissed: ReadonlyMap<string, Pending>;
};

export type NoteChange =
  | { kind: "rename"; id: string; title: string }
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
      return { ...overlay, titles: new Map(overlay.titles).set(change.id, { ...pending, title: change.title }) };
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
 * that title (or is gone), a delete once the note is gone, a dismissal once
 * the failed import is gone. The same overlay when there are none.
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
    titles: prune(overlay.titles, (id, entry) => !titles.has(id) || titles.get(id) === entry.title),
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
 * Owns the overlay; the vault shell calls it once and provides the result.
 *
 * `notes` and `failedImports` are the layout's server data, which entries are
 * settled against. `location` is the current pathname: when it changes (a
 * navigation committed) while confirmed entries still wait, `refresh` runs
 * again, since the navigation may have discarded the earlier one.
 *
 * `run` applies `change` at once and calls `action` (the API request)
 * outside any transition. When it resolves, the entry is confirmed and
 * `refresh` (router.refresh) fetches the server data that will settle it.
 * When it throws, that entry alone is dropped and `onError` gets the error;
 * when no answer came at all the server may have done the work anyway, so
 * `refresh` runs then too.
 */
export function useNoteOverlayState({
  notes,
  failedImports,
  location,
  refresh,
}: {
  notes: { id: string; title: string }[];
  failedImports: { id: string }[];
  location: string;
  refresh: () => void;
}): { overlay: NoteOverlay; run: RunChange } {
  const [raw, setRaw] = useState(EMPTY_OVERLAY);
  const overlay = useMemo(() => settleOverlay(raw, notes, failedImports), [raw, notes, failedImports]);
  // Settled entries leave the state on this same render, so one cannot
  // linger and later cover a title that changed again on the server.
  if (overlay !== raw) setRaw(overlay);

  const nextToken = useRef(0);
  const run = useCallback<RunChange>(
    (change, action, onError) => {
      const token = ++nextToken.current;
      setRaw((prev) => applyChange(prev, change, token));
      void (async () => {
        try {
          await action();
        } catch (error) {
          setRaw((prev) => dropChange(prev, change, token));
          onError(error);
          if (error instanceof NoResponseError) refresh();
          return;
        }
        setRaw((prev) => confirmChange(prev, change, token, Date.now()));
        refresh();
      })();
    },
    [refresh],
  );

  // The fallback for a confirmed entry that server data never shows.
  useEffect(() => {
    const times = confirmedTimes(overlay);
    if (times.length === 0) return;
    const wait = Math.max(0, Math.min(...times) + CONFIRMED_TTL_MS - Date.now());
    const timer = setTimeout(() => setRaw((prev) => expireOverlay(prev, Date.now())), wait);
    return () => clearTimeout(timer);
  }, [overlay]);

  const latest = useRef(overlay);
  useEffect(() => {
    latest.current = overlay;
  }, [overlay]);
  const lastLocation = useRef(location);
  useEffect(() => {
    if (lastLocation.current === location) return;
    lastLocation.current = location;
    if (confirmedTimes(latest.current).length > 0) refresh();
  }, [location, refresh]);

  return { overlay, run };
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
