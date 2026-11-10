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

export type NoteStore = {
  /** The workspace the copy belongs to; null before any snapshot. */
  workspaceId: string | null;
  /** When the newest snapshot applied was read on the server (ms). */
  loadedAt: number;
  /** In the order the server lists them (by title). */
  docs: Doc[];
  /**
   * Text typed into a note and not yet saved when its editor closed. It is
   * based on that note's `markdown` at its `version`, which stay as they were
   * so the next save of it is checked against the version it came from.
   */
  drafts: ReadonlyMap<string, string>;
};

export const EMPTY_NOTE_STORE: NoteStore = { workspaceId: null, loadedAt: 0, docs: [], drafts: new Map() };

/** What a note page sends: the active workspace's notes, read at `loadedAt`. */
export type NoteSnapshot = { workspaceId: string; loadedAt: number; docs: Doc[] };

function version(doc: Doc): number {
  return doc.version ?? 0;
}

/**
 * The store with a server snapshot taken in. Another workspace's snapshot
 * replaces it. A snapshot older than one already taken in (a page brought
 * back from the router's cache) changes nothing. Otherwise the server's list
 * wins, except for a note this client holds at a newer version, or with
 * unsaved text: its text and version stay (the title comes from the server).
 */
export function seedNotes(store: NoteStore, snapshot: NoteSnapshot): NoteStore {
  if (store.workspaceId !== snapshot.workspaceId) {
    return { workspaceId: snapshot.workspaceId, loadedAt: snapshot.loadedAt, docs: snapshot.docs, drafts: new Map() };
  }
  if (snapshot.loadedAt < store.loadedAt) return store;

  const local = new Map(store.docs.map((doc) => [doc.id, doc]));
  const docs = snapshot.docs.map((doc) => {
    const mine = local.get(doc.id);
    if (!mine) return doc;
    if (store.drafts.has(doc.id) || version(mine) > version(doc)) {
      return mine.title === doc.title ? mine : { ...mine, title: doc.title };
    }
    return doc;
  });
  let drafts = store.drafts;
  const ids = new Set(docs.map((doc) => doc.id));
  for (const id of store.drafts.keys()) {
    if (ids.has(id)) continue;
    if (drafts === store.drafts) drafts = new Map(store.drafts);
    (drafts as Map<string, string>).delete(id);
  }
  return { workspaceId: store.workspaceId, loadedAt: snapshot.loadedAt, docs, drafts };
}

/** What an editor holds when it closes: the stored text at its version, and its own text. */
export type EditorCopy = { saved: string; version: number; text: string };

/**
 * The store once a note's editor has closed, so the next visit shows what it
 * showed. Its saved text replaces the store's unless the store already has a
 * newer version. Unsaved text is kept as a draft with the saved text it was
 * typed over, even when that is older: its save must then be refused.
 */
export function keepEditorCopy(store: NoteStore, id: string, copy: EditorCopy): NoteStore {
  const index = store.docs.findIndex((doc) => doc.id === id);
  if (index < 0) return store;
  const doc = store.docs[index];
  const unsaved = copy.text !== copy.saved;
  if (!unsaved && copy.version < version(doc)) {
    if (!store.drafts.has(id)) return store;
    const drafts = new Map(store.drafts);
    drafts.delete(id);
    return { ...store, drafts };
  }
  const docs = [...store.docs];
  docs[index] = doc.markdown === copy.saved && version(doc) === copy.version
    ? doc
    : { ...doc, markdown: copy.saved, version: copy.version };
  const drafts = new Map(store.drafts);
  if (unsaved) drafts.set(id, copy.text);
  else drafts.delete(id);
  return { ...store, docs, drafts };
}

/** A note's row as read again on opening it from the store. */
export type NoteRow = Required<Pick<Doc, "markdown" | "version" | "mindmap" | "mindmapStale">>;

/**
 * The store with a re-read row taken in: the row's text, version and map
 * replace the copy's when it is at least as new and the copy has no unsaved
 * text. Unsaved text keeps the version it was typed over, so the editor sees
 * the conflict.
 */
export function takeRow(store: NoteStore, id: string, row: NoteRow): NoteStore {
  const index = store.docs.findIndex((doc) => doc.id === id);
  if (index < 0 || store.drafts.has(id)) return store;
  const doc = store.docs[index];
  if (row.version < version(doc)) return store;
  const docs = [...store.docs];
  docs[index] = { ...doc, ...row };
  return { ...store, docs };
}

/**
 * What an editor opened from the store does with its re-read row:
 * - `keep`: the row is no newer than the editor's copy;
 * - `adopt`: the row is newer and nothing is typed over the copy, so the
 *   editor takes the row's text and version before it can save;
 * - `conflict`: the row is newer and the editor holds unsaved text typed over
 *   the older copy. The text stays, and the editor stops saving and offers a
 *   reload, as when the server refuses a save as stale.
 */
export function refreshVerdict(
  editor: { version: number; unsaved: boolean },
  row: { version: number },
): "keep" | "adopt" | "conflict" {
  if (row.version <= editor.version) return "keep";
  return editor.unsaved ? "conflict" : "adopt";
}

/**
 * The store once the server has renamed a note: its new title, and the text
 * the rename wrote (it may rewrite the title heading) unless this client
 * already holds a newer version, or unsaved text typed over the old one.
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
  if (
    renamed.markdown !== undefined &&
    renamed.version !== undefined &&
    renamed.version > version(doc) &&
    !store.drafts.has(id)
  ) {
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
  const drafts = new Map(store.drafts);
  drafts.delete(id);
  return { ...store, docs: store.docs.filter((doc) => doc.id !== id), drafts };
}

/** The note a vault path opens, as `/vault/<id>`; null for every other route. */
export function notePathId(pathname: string): string | null {
  const match = /^\/vault\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(pathname);
  return match ? match[1] : null;
}

/**
 * Which note the vault's host may show, and from which URL (see
 * components/vault/note-store.tsx). `via` lists the paths the router may
 * still report while it catches up with a pushed URL: its update is a
 * transition, which can wait behind another one in flight.
 */
export type HostTrust = { id: string; path: string; via: string[] };

/** The path the host follows: the trusted one while the router still reports a path it passed through. */
export function hostPath(trust: HostTrust | null, pathname: string): string {
  return trust && trust.via.includes(pathname) ? trust.path : pathname;
}

/** The paths a switch made now passes through, starting at what the router reports. */
export function switchVia(trust: HostTrust | null, pathname: string): string[] {
  return trust && trust.via.includes(pathname) ? [...trust.via, trust.path] : [pathname];
}

/** Whether the trust still holds once the router reports `pathname`. */
export function trustHolds(trust: HostTrust, pathname: string): boolean {
  return trust.path === pathname || trust.via.includes(pathname);
}
