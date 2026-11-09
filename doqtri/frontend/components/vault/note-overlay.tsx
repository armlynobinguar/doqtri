"use client";

import { createContext, startTransition, useCallback, useContext, useMemo, useOptimistic } from "react";

/*
 * Vault actions used to wait for two round trips before the screen changed:
 * the API call, then router.refresh() re-running the layout (the explorer's
 * notes) and the page (every note's text, for the tab, graph and mindmap).
 * The overlay is what the client shows in the meantime: the changes it has
 * asked for and not yet seen in server data, laid over whatever the server
 * last rendered.
 *
 * It is React's useOptimistic over an empty base. Each change runs in a
 * transition together with its API call and the refresh after it; the
 * refresh joins that transition, so the change stays on screen until the
 * fresh server data commits in the same frame it drops out. If the call
 * fails, the transition ends without new data and the change simply drops,
 * which puts the old title or row back on every surface at once.
 */

/** What the client has asked the server for and not yet seen back. */
export type NoteOverlay = {
  /** Note id → the title it is being renamed to. */
  titles: ReadonlyMap<string, string>;
  /** Notes being deleted. */
  deleted: ReadonlySet<string>;
  /** Failed imports (ingest ids) being dismissed. */
  dismissed: ReadonlySet<string>;
};

export type NoteChange =
  | { kind: "rename"; id: string; title: string }
  | { kind: "delete"; id: string }
  | { kind: "dismiss"; id: string };

export const EMPTY_OVERLAY: NoteOverlay = {
  titles: new Map(),
  deleted: new Set(),
  dismissed: new Set(),
};

/** The overlay with one more change on it. Never mutates `overlay`. */
export function applyChange(overlay: NoteOverlay, change: NoteChange): NoteOverlay {
  switch (change.kind) {
    case "rename":
      return { ...overlay, titles: new Map(overlay.titles).set(change.id, change.title) };
    case "delete":
      return { ...overlay, deleted: new Set(overlay.deleted).add(change.id) };
    case "dismiss":
      return { ...overlay, dismissed: new Set(overlay.dismissed).add(change.id) };
  }
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
      const title = overlay.titles.get(item.id);
      return title === undefined || title === item.title ? item : { ...item, title };
    });
}

/** Whether a rename or delete of this note is still waiting on the server. */
export function isNotePending(overlay: NoteOverlay, id: string): boolean {
  return overlay.titles.has(id) || overlay.deleted.has(id);
}

/**
 * Owns the overlay; the vault shell calls it once and provides the result.
 *
 * `run` applies `change` at once, then calls `action` (the API request).
 * When it resolves, `refresh` (router.refresh) runs inside the same
 * transition, so the change holds until the server's data replaces it. When
 * it throws, `onError` gets the error and the change drops. Errors are
 * caught here because an error thrown out of a transition goes to the
 * nearest error boundary, which would replace the vault with an error page.
 */
export function useNoteOverlayState(refresh: () => void): {
  overlay: NoteOverlay;
  run: (change: NoteChange, action: () => Promise<void>, onError: (error: unknown) => void) => void;
} {
  const [overlay, addChange] = useOptimistic(EMPTY_OVERLAY, applyChange);

  const run = useCallback(
    (change: NoteChange, action: () => Promise<void>, onError: (error: unknown) => void) => {
      startTransition(async () => {
        addChange(change);
        try {
          await action();
        } catch (error) {
          onError(error);
          return;
        }
        refresh();
      });
    },
    [addChange, refresh],
  );

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
  return useNoteOverlay().titles.get(id) ?? title;
}
