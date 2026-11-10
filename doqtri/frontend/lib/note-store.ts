import type { Doc } from "@/lib/types";

/*
 * The vault's copy of its notes on the client (DOQ-43, WP-1.7).
 *
 * The note page loads every note of the active workspace for the graph,
 * backlinks and [[wikilinks]]. The client keeps that snapshot, so opening
 * another note of the same workspace needs no server render: the note shows
 * from this copy at once, and its row is read again to catch up with saves
 * made since. This file is the plain data side of that; the React side is
 * components/vault/note-store.tsx.
 */

/** Text an editor could not save as it closed, and the version it was typed over. */
export type UnsavedText = { text: string; version: number };

export type NoteStore = {
  /** The workspace the copy belongs to; null before any snapshot. */
  workspaceId: string | null;
  /** When the newest snapshot applied was read on the server (ms). */
  loadedAt: number;
  /** Saved text and versions, in the order the server lists them (by title). */
  docs: Doc[];
  /**
   * Only for an editor whose last save failed as it closed: its text, kept
   * so the next visit shows it, never reloaded over, with the version it was
   * typed over so a save of it is refused if the note has moved on.
   */
  unsaved: ReadonlyMap<string, UnsavedText>;
};

export const EMPTY_NOTE_STORE: NoteStore = { workspaceId: null, loadedAt: 0, docs: [], unsaved: new Map() };

/** What a note page sends: the active workspace's notes, read at `loadedAt`. */
export type NoteSnapshot = { workspaceId: string; loadedAt: number; docs: Doc[] };

function version(doc: Doc): number {
  return doc.version ?? 0;
}

function unsavedOnly(store: NoteStore, keep: (id: string) => boolean): ReadonlyMap<string, UnsavedText> {
  if ([...store.unsaved.keys()].every(keep)) return store.unsaved;
  return new Map([...store.unsaved].filter(([id]) => keep(id)));
}

/**
 * The store with a server snapshot taken in. Another workspace's snapshot
 * replaces it. A snapshot older than one already taken in (a page brought
 * back from the router's cache) changes nothing. Otherwise the server's list
 * wins, except for a note this client holds at a newer version: its text and
 * version stay (the title comes from the server).
 */
export function seedNotes(store: NoteStore, snapshot: NoteSnapshot): NoteStore {
  if (store.workspaceId !== snapshot.workspaceId) {
    return { workspaceId: snapshot.workspaceId, loadedAt: snapshot.loadedAt, docs: snapshot.docs, unsaved: new Map() };
  }
  if (snapshot.loadedAt < store.loadedAt) return store;

  const local = new Map(store.docs.map((doc) => [doc.id, doc]));
  const docs = snapshot.docs.map((doc) => {
    const mine = local.get(doc.id);
    if (!mine || version(mine) <= version(doc)) return doc;
    return mine.title === doc.title ? mine : { ...mine, title: doc.title };
  });
  const ids = new Set(docs.map((doc) => doc.id));
  return { ...store, loadedAt: snapshot.loadedAt, docs, unsaved: unsavedOnly(store, (id) => ids.has(id)) };
}

/**
 * What an editor reports once it has closed and its last save has settled:
 * the stored text at its version, the map it showed, and the text that last
 * save could not store, if it failed.
 */
export type EditorCopy = Pick<Doc, "mindmap" | "mindmapStale"> & {
  saved: string;
  version: number;
  unsaved?: UnsavedText;
};

/**
 * The store once a note's editor has closed, so the next visit shows what it
 * showed: its saved text, version and map, unless the store already holds a
 * newer version. Unsaved text is kept only when the editor reports one.
 */
export function keepEditorCopy(store: NoteStore, id: string, copy: EditorCopy): NoteStore {
  const index = store.docs.findIndex((doc) => doc.id === id);
  if (index < 0) return store;
  const doc = store.docs[index];
  const docs = [...store.docs];
  if (copy.version >= version(doc)) {
    docs[index] = { ...doc, markdown: copy.saved, version: copy.version, mindmap: copy.mindmap, mindmapStale: copy.mindmapStale };
  }
  const unsaved = new Map(store.unsaved);
  if (copy.unsaved) unsaved.set(id, copy.unsaved);
  else unsaved.delete(id);
  return { ...store, docs, unsaved };
}

/** A note's row as read again on opening it from the store. */
export type NoteRow = Required<Pick<Doc, "markdown" | "version" | "mindmap" | "mindmapStale">>;

/** The store with a re-read row taken in, unless the copy is newer already. */
export function takeRow(store: NoteStore, id: string, row: NoteRow): NoteStore {
  const index = store.docs.findIndex((doc) => doc.id === id);
  if (index < 0) return store;
  const doc = store.docs[index];
  if (row.version < version(doc)) return store;
  const docs = [...store.docs];
  docs[index] = { ...doc, ...row };
  return { ...store, docs };
}

/**
 * What an editor opened from the store does with its re-read row:
 * - `keep`: the row is no newer than the editor's copy;
 * - `adopt`: the row is newer, and the editor holds no unsaved text (or the
 *   row holds exactly that text), so it takes the row's text and version
 *   before it can save;
 * - `conflict`: the row is newer and the editor holds text a failed save
 *   left over the older copy. The text stays, and the editor stops saving and
 *   offers a reload, as when the server refuses a save as stale.
 */
export function refreshVerdict(
  editor: { version: number; text: string; unsaved: boolean },
  row: { version: number; markdown: string },
): "keep" | "adopt" | "conflict" {
  if (row.version <= editor.version) return "keep";
  return editor.unsaved && row.markdown !== editor.text ? "conflict" : "adopt";
}

/**
 * The store once the server has renamed a note: its new title, and the text
 * the rename wrote (it may rewrite the title heading) unless this client
 * already holds a newer version.
 */
export function takeRename(
  store: NoteStore,
  id: string,
  renamed: { title: string; markdown?: string; version?: number },
): NoteStore {
  const index = store.docs.findIndex((doc) => doc.id === id);
  if (index < 0) return store;
  const doc = store.docs[index];
  let next: Doc = doc.title === renamed.title ? doc : { ...doc, title: renamed.title };
  if (renamed.markdown !== undefined && renamed.version !== undefined && renamed.version > version(doc)) {
    next = { ...next, markdown: renamed.markdown, version: renamed.version };
  }
  if (next === doc) return store;
  const docs = [...store.docs];
  docs[index] = next;
  return { ...store, docs };
}

/** The store without a note the server has deleted. */
export function dropNote(store: NoteStore, id: string): NoteStore {
  if (!store.docs.some((doc) => doc.id === id)) return store;
  return {
    ...store,
    docs: store.docs.filter((doc) => doc.id !== id),
    unsaved: unsavedOnly(store, (other) => other !== id),
  };
}

/** The note a vault path opens, as `/vault/<id>`; null for every other route. */
export function notePathId(pathname: string): string | null {
  const match = /^\/vault\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(pathname);
  return match ? match[1] : null;
}

/*
 * Which note the vault's host shows (components/vault/note-store.tsx).
 *
 * `trusted` is the note the host may show from the copy: one opened here
 * from a shown note, or by back/forward (`recheck`: its row is read again),
 * or the one a server render of the note page just sent its snapshot for.
 * `pushed` is a URL this client pushed (a switch, or back/forward between
 * notes) that the router has not reported yet. Its update is a transition,
 * which can wait behind another one in flight, so until then the host
 * follows `pushed`.
 */
export type HostState = { pushed: string | null; trusted: { id: string; recheck: boolean } | null };

export type HostEvent =
  /** A switch from a shown note: the URL was pushed. */
  | { type: "open"; id: string }
  /** Back or forward to a note in the copy, from a shown note or another route. */
  | { type: "popstate"; id: string; fromNote: boolean }
  /** The router reports `pathname`; `location` is the browser's. */
  | { type: "router"; pathname: string; location: string }
  /** A note page's snapshot was taken in; `fresh` unless it was older than the copy. */
  | { type: "seed"; id: string; location: string; fresh: boolean };

export const EMPTY_HOST: HostState = { pushed: null, trusted: null };

export function hostStep(state: HostState, event: HostEvent): HostState {
  switch (event.type) {
    case "open":
      return { pushed: `/vault/${event.id}`, trusted: { id: event.id, recheck: true } };
    case "popstate":
      // From another route the host waits for the router, so that route's
      // page is gone by the time the note shows.
      return { pushed: event.fromNote ? `/vault/${event.id}` : null, trusted: { id: event.id, recheck: true } };
    case "router": {
      const pushed = state.pushed && event.pathname !== event.location ? state.pushed : null;
      // Gone elsewhere: a later server render of this note waits for its
      // own snapshot.
      const trusted =
        state.trusted && notePathId(pushed ?? event.pathname) === state.trusted.id ? state.trusted : null;
      return pushed === state.pushed && trusted === state.trusted ? state : { pushed, trusted };
    }
    case "seed":
      // A refresh started on another note may answer after a switch.
      if (event.location !== `/vault/${event.id}` || state.trusted?.id === event.id) return state;
      return { ...state, trusted: { id: event.id, recheck: !event.fresh } };
  }
}

/** The note the host shows while the router reports `pathname`, if any. */
export function hostShows(state: HostState, pathname: string): string | null {
  const id = notePathId(state.pushed ?? pathname);
  return id !== null && state.trusted?.id === id ? id : null;
}
