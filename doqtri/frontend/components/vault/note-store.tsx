"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DoqtriLoader } from "@/components/brand/doqtri-loader";
import { useNavigate, useNavigationStatus } from "@/components/vault/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isMindmapStaleWeb } from "@/lib/mindmap-hash-web";
import { parseDocMindmap } from "@/lib/mindmap-types";
import {
  dropNote,
  EMPTY_NOTE_STORE,
  hostPath,
  keepEditorCopy,
  notePathId,
  refreshVerdict,
  seedNotes,
  switchVia,
  takeRename,
  takeRow,
  trustHolds,
  type EditorCopy,
  type HostTrust,
  type NoteRow,
  type NoteSnapshot,
  type NoteStore,
} from "@/lib/note-store";
import type { Doc } from "@/lib/types";

/*
 * Opening another note of the workspace on the client (DOQ-43, WP-1.7).
 *
 * The note page used to be the editor's home, so every note switch was a
 * server render that read every note of the workspace again. Now the page
 * only sends that snapshot (NoteSnapshot), and the editor lives here, in the
 * vault shell (NoteHost), fed from the client's copy of the notes. A switch
 * within the workspace pushes /vault/<id> onto the history itself, with no
 * request for the route, and the note shows from the copy at once; its row
 * is read again and the editor stays read-only until it answers (see
 * useCheckedCopy).
 *
 * The editor is hosted in the shell rather than the page because a pushed
 * URL leaves Next's route tree on the note the page was rendered for. The
 * next router.refresh() (a rename, a rebuilt map, a heading rename) renders
 * the page for the URL's note, and Next remounts the page under a new
 * [docId]: an editor in the page would lose its caret, unsaved text and lock
 * mid-edit. The shell is not remounted.
 *
 * Which note the host shows is the URL's, once the host trusts its copy of it:
 * - a switch from here (openNote) or a back/forward between notes: at once,
 *   with the row read again;
 * - any server render of the note page (a direct load, a reload, a server
 *   navigation, a refresh): when its snapshot has been taken in, in the same
 *   commit, before anything is painted. Showing the copy any sooner would
 *   start the editor on text older than the page brings.
 * Everything else (another workspace's note, an unknown id, every other
 * vault route) still goes through the server with the navigation loader.
 */

/** A note's row read again, or null when it is gone; undefined when the read failed. */
type Check = Promise<NoteRow | null | undefined>;

/** HostTrust, with the row read started when the note was opened from the copy. */
type Trust = HostTrust & { check: Check | null };

type NoteStoreValue = {
  /** The note the host shows, from the copy. */
  shown: Doc | null;
  /** The copy's notes, for the graph, backlinks and [[wikilinks]]. */
  docs: Doc[];
  drafts: ReadonlyMap<string, string>;
  check: Check | null;
  open: (id: string) => void;
  seed: (snapshot: NoteSnapshot, docId: string) => void;
  keep: (id: string, copy: EditorCopy) => void;
  renamed: (id: string, renamed: { title: string; markdown?: string; version?: number }) => void;
  deleted: (id: string) => void;
};

const NoteStoreContext = createContext<NoteStoreValue | null>(null);

/** Reads one note's row through RLS, with its map's staleness decided here. */
async function readRow(id: string): Promise<NoteRow | null | undefined> {
  try {
    const { data, error } = await createSupabaseBrowserClient()
      .from("documents")
      .select("markdown, version, mindmap, mindmap_hash")
      .eq("id", id)
      .maybeSingle();
    if (error) return undefined;
    if (!data) return null;
    const mindmap = parseDocMindmap(data.mindmap);
    return {
      markdown: data.markdown as string,
      version: Number(data.version),
      mindmap,
      // A note with no map is not "stale", as in lib/load-docs.ts.
      mindmapStale: mindmap !== null && (await isMindmapStaleWeb(data.markdown, data.mindmap_hash)),
    };
  } catch {
    return undefined;
  }
}

/** The vault's copy of the active workspace's notes; the vault shell provides it. */
export function NoteStoreProvider({ workspaceId, children }: { workspaceId: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const navigate = useNavigate();
  const { isNavigating } = useNavigationStatus();

  // The refs are the truth, written only from handlers and effects; the
  // state mirrors them so the vault renders what they hold.
  const storeRef = useRef<NoteStore>(EMPTY_NOTE_STORE);
  const [store, setStore] = useState<NoteStore>(EMPTY_NOTE_STORE);
  const update = useCallback((change: (store: NoteStore) => NoteStore) => {
    const next = change(storeRef.current);
    if (next === storeRef.current) return;
    storeRef.current = next;
    setStore(next);
  }, []);

  const trustRef = useRef<Trust | null>(null);
  const [trust, setTrustState] = useState<Trust | null>(null);
  const setTrust = useCallback((next: Trust | null) => {
    trustRef.current = next;
    setTrustState(next);
  }, []);

  const shownPath = hostPath(trust, pathname);
  const shownId = notePathId(shownPath);
  const shown = useMemo(
    () =>
      trust && shownId && trust.id === shownId && trust.path === shownPath && store.workspaceId === workspaceId
        ? (store.docs.find((doc) => doc.id === shownId) ?? null)
        : null,
    [store, trust, shownId, shownPath, workspaceId],
  );

  // For handlers: the path as last rendered and the note shown then.
  const rendered = useRef({ pathname, shownId: shown?.id ?? null });
  useLayoutEffect(() => {
    rendered.current = { pathname, shownId: shown?.id ?? null };
  }, [pathname, shown]);

  // A navigation went elsewhere: what was trusted no longer is, so a later
  // server render of that note waits for its own snapshot.
  useLayoutEffect(() => {
    const current = trustRef.current;
    if (current && !trustHolds(current, pathname)) setTrust(null);
  }, [pathname, setTrust]);

  const has = useCallback(
    (id: string) => storeRef.current.workspaceId === workspaceId && storeRef.current.docs.some((doc) => doc.id === id),
    [workspaceId],
  );

  const startCheck = useCallback(
    (id: string): Check => {
      const check = readRow(id);
      void check.then((row) => {
        if (row) {
          update((store) => takeRow(store, id, row));
          return;
        }
        if (row === null && trustRef.current?.id === id) {
          // Deleted, or no longer readable, since the copy was taken: the
          // server says which (a 404, or the workspace it moved to).
          navigate(`/vault/${id}`);
          update((store) => dropNote(store, id));
        }
      });
      return check;
    },
    [navigate, update],
  );

  const open = useCallback(
    (id: string) => {
      const href = `/vault/${id}`;
      const here = rendered.current;
      if (here.shownId === id) return;
      // Only from a note shown here, to a note of the same workspace in the
      // copy, and never over a server navigation still under way.
      if (!here.shownId || isNavigating() || !has(id)) {
        navigate(href);
        return;
      }
      setTrust({ id, path: href, via: switchVia(trustRef.current, here.pathname), check: startCheck(id) });
      window.history.pushState(null, "", href);
    },
    [has, isNavigating, navigate, setTrust, startCheck],
  );

  // Back and forward between notes stay on the client. Next restores the
  // history entry's route tree; the host follows the URL.
  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname;
      const id = notePathId(path);
      const here = rendered.current;
      if (id && id === here.shownId) return;
      if (!id || !has(id)) {
        setTrust(null);
        // A note this copy does not have (deleted since, or another
        // workspace's): the server decides what that URL shows.
        if (id) navigate(path);
        return;
      }
      // From another note the host switches at once; from another route it
      // switches when the router does, so that route's page is gone by then.
      const via = here.shownId ? switchVia(trustRef.current, here.pathname) : [];
      setTrust({ id, path, via, check: startCheck(id) });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [has, navigate, setTrust, startCheck]);

  const seed = useCallback(
    (snapshot: NoteSnapshot, docId: string) => {
      const before = storeRef.current;
      const fresh = before.workspaceId !== snapshot.workspaceId || snapshot.loadedAt >= before.loadedAt;
      update((store) => seedNotes(store, snapshot));
      // The shell still shows another workspace: WorkspaceGuard refreshes it,
      // and this runs again once it has.
      if (snapshot.workspaceId !== workspaceId) return;
      const path = `/vault/${docId}`;
      // A refresh started on another note may answer after a switch.
      if (window.location.pathname !== path) return;
      if (trustRef.current?.id === docId && trustRef.current.path === path) return;
      if (!has(docId)) {
        // A page brought back from the router's cache, for a note this copy
        // no longer has: ask the server again.
        if (!isNavigating()) navigate(path);
        return;
      }
      setTrust({ id: docId, path, via: [], check: fresh ? null : startCheck(docId) });
    },
    [has, isNavigating, navigate, setTrust, startCheck, update, workspaceId],
  );

  const keep = useCallback((id: string, copy: EditorCopy) => update((store) => keepEditorCopy(store, id, copy)), [update]);
  const renamed = useCallback(
    (id: string, next: { title: string; markdown?: string; version?: number }) =>
      update((store) => takeRename(store, id, next)),
    [update],
  );
  const deleted = useCallback((id: string) => update((store) => dropNote(store, id)), [update]);

  const value = useMemo<NoteStoreValue>(
    () => ({
      shown,
      docs: store.docs,
      drafts: store.drafts,
      check: shown ? (trust?.check ?? null) : null,
      open,
      seed,
      keep,
      renamed,
      deleted,
    }),
    [shown, store, trust, open, seed, keep, renamed, deleted],
  );

  return <NoteStoreContext.Provider value={value}>{children}</NoteStoreContext.Provider>;
}

/** The vault's note copy and host state; null outside the vault shell. */
export function useNoteStore(): NoteStoreValue | null {
  return useContext(NoteStoreContext);
}

/** The id of the note the vault shows, when it shows one. */
export function useShownNoteId(): string | undefined {
  return useContext(NoteStoreContext)?.shown?.id;
}

/**
 * Opens a note: on the client when it can (see NoteStoreProvider), else
 * through the server with the navigation loader.
 */
export function useOpenNote(): (id: string) => void {
  const store = useContext(NoteStoreContext);
  const navigate = useNavigate();
  return store?.open ?? ((id) => navigate(`/vault/${id}`));
}

/**
 * A link to a note that opens it through useOpenNote. The real `href` stays,
 * so modifier-clicks, middle-clicks and "open in new tab" load the note
 * page as before. While a note is shown a click never uses a prefetch, so
 * none is made.
 */
export function NoteLink({
  noteId,
  onNavigate,
  ...props
}: Omit<React.ComponentProps<typeof Link>, "href"> & { noteId: string }) {
  const store = useContext(NoteStoreContext);
  const open = useOpenNote();
  return (
    <Link
      prefetch={store?.shown ? false : undefined}
      {...props}
      href={`/vault/${noteId}`}
      onNavigate={(event) => {
        onNavigate?.(event);
        event.preventDefault();
        open(noteId);
      }}
    />
  );
}

/**
 * What the note page renders: it hands the snapshot it loaded to the vault's
 * copy, in a layout effect so the host shows the note before the browser
 * paints. Until the host shows it (the server's HTML, before hydration) it
 * stands in with the loader.
 */
export function NoteSnapshotSeed({ docId, ...snapshot }: NoteSnapshot & { docId: string }) {
  const store = useContext(NoteStoreContext);
  const seed = store?.seed;
  const { workspaceId, loadedAt, docs } = snapshot;
  useLayoutEffect(() => {
    seed?.({ workspaceId, loadedAt, docs }, docId);
  }, [seed, workspaceId, loadedAt, docs, docId]);
  if (store?.shown) return null;
  return (
    <div data-testid="note-loading" className="flex h-full w-full items-center justify-center">
      <DoqtriLoader className="w-20" />
    </div>
  );
}

/**
 * For an editor opened from the copy: whether its row is still being read
 * again. The editor stays read-only meanwhile; once the row answers, a newer
 * version replaces the copy's text (`adopt`), or, when unsaved text was typed
 * over the older copy, stops saving with the conflict banner (`conflict`).
 * A failed read leaves the copy as it is: a save on an old version is still
 * refused by the server.
 */
export function useCheckedCopy(
  check: Check | undefined,
  editor: {
    version: () => number;
    unsaved: () => boolean;
    adopt: (row: NoteRow) => void;
    conflict: () => void;
  },
): boolean {
  const [checking, setChecking] = useState(check !== undefined);
  const latest = useRef(editor);
  useEffect(() => {
    latest.current = editor;
  });
  useEffect(() => {
    if (!check) return;
    let live = true;
    void check.then((row) => {
      if (!live) return;
      if (row) {
        const { version, unsaved, adopt, conflict } = latest.current;
        const verdict = refreshVerdict({ version: version(), unsaved: unsaved() }, row);
        if (verdict === "adopt") adopt(row);
        else if (verdict === "conflict") conflict();
      }
      setChecking(false);
    });
    return () => {
      live = false;
    };
  }, [check]);
  return checking;
}
