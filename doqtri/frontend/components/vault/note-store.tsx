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
  EMPTY_HOST,
  EMPTY_NOTE_STORE,
  hostShows,
  hostStep,
  keepEditorCopy,
  notePathId,
  refreshVerdict,
  seedNotes,
  takeRename,
  takeRow,
  type EditorCopy,
  type HostEvent,
  type HostState,
  type NoteRow,
  type NoteSnapshot,
  type NoteStore,
  type UnsavedText,
} from "@/lib/note-store";
import type { Doc } from "@/lib/types";

/*
 * Opening another note of the workspace on the client (DOQ-43, WP-1.7).
 *
 * The note page used to be the editor's home, so every note switch was a
 * server render that read every note of the workspace again. Now the page
 * only sends that snapshot (NoteSnapshotSeed), and the editor lives in the
 * vault shell (NoteHost), fed from the client's copy of the notes. A switch
 * within the workspace pushes /vault/<id> onto the history itself, with no
 * request for the route, and the note shows from the copy at once. The
 * editor then reads its row again and stays read-only until it answers
 * (useCheckedCopy). Leaving a note saves what is typed before its lock goes
 * (hooks/use-doc-lock.ts), and the copy takes the saved text.
 *
 * The editor is hosted in the shell rather than the page because a pushed
 * URL leaves Next's route tree on the note the page was rendered for. The
 * next router.refresh() (a rename, a rebuilt map, a heading rename) renders
 * the page for the URL's note, and Next remounts the page under a new
 * [docId]: an editor in the page would lose its caret, unsaved text and lock
 * mid-edit. The shell is not remounted.
 *
 * Which note the host shows is decided by hostStep() in lib/note-store.ts.
 * Everything else (another workspace's note, an unknown id, every other
 * vault route) still goes through the server with the navigation loader.
 *
 * Known and accepted:
 * - A direct load or reload shows the loader in the main pane until the page
 *   hydrates: the editor is no longer in the server's HTML (it rendered on
 *   the client only before, too).
 * - Only the opened note is read again. The other notes' copies (titles and
 *   text for the graph, backlinks and [[wikilinks]]) stay as the last server
 *   render sent them, plus this client's own saves, renames and deletes,
 *   until the next one. A workspace switch made in another tab is not seen
 *   by switches here; the next server render's WorkspaceGuard catches it.
 */

/** A note's row read again: null when it is gone, undefined when the read failed. */
type Reread = (id: string) => Promise<NoteRow | null | undefined>;

type NoteStoreValue = {
  /** The note the host shows, from the copy. */
  shown: Doc | null;
  /** Whether the shown note was opened from the copy, so its row must be read again. */
  recheck: boolean;
  /** The copy's notes, for the graph, backlinks and [[wikilinks]]. */
  docs: Doc[];
  unsaved: ReadonlyMap<string, UnsavedText>;
  open: (id: string) => void;
  seed: (snapshot: NoteSnapshot, docId: string) => void;
  reread: Reread;
  /**
   * An editor closed. A promise is a last save still out: the note stays
   * hidden until it settles, so it reopens on the text that save stored.
   */
  leave: (id: string, copy: EditorCopy | Promise<EditorCopy>) => void;
  renamed: (id: string, renamed: { title: string; markdown?: string; version?: number }) => void;
  deleted: (id: string) => void;
};

const NoteStoreContext = createContext<NoteStoreValue | null>(null);

/** Reads one note of the workspace through RLS, with its map's staleness decided here. */
async function readRow(id: string, workspaceId: string): Promise<NoteRow | null | undefined> {
  try {
    const { data, error } = await createSupabaseBrowserClient()
      .from("documents")
      .select("markdown, version, mindmap, mindmap_hash")
      .eq("id", id)
      .eq("workspace_id", workspaceId)
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

  const hostRef = useRef<HostState>(EMPTY_HOST);
  const [host, setHost] = useState<HostState>(EMPTY_HOST);
  const step = useCallback((event: HostEvent) => {
    const next = hostStep(hostRef.current, event);
    if (next === hostRef.current) return;
    hostRef.current = next;
    setHost(next);
  }, []);

  // Notes whose editor closed and whose last save is still out: shown again
  // once it settles, from the text it stored.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());

  const shownId = hostShows(host, pathname);
  const shown = useMemo(
    () =>
      shownId && !leaving.has(shownId) && store.workspaceId === workspaceId
        ? (store.docs.find((doc) => doc.id === shownId) ?? null)
        : null,
    [store, shownId, leaving, workspaceId],
  );

  // For handlers: the path as last rendered and the note shown then.
  const rendered = useRef({ pathname, shownId });
  useLayoutEffect(() => {
    rendered.current = { pathname, shownId };
  }, [pathname, shownId]);

  // The router caught up with a pushed URL, or went elsewhere.
  useLayoutEffect(() => {
    step({ type: "router", pathname, location: window.location.pathname });
  }, [pathname, step]);

  const has = useCallback(
    (id: string) => storeRef.current.workspaceId === workspaceId && storeRef.current.docs.some((doc) => doc.id === id),
    [workspaceId],
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
      step({ type: "open", id });
      window.history.pushState(null, "", href);
    },
    [has, isNavigating, navigate, step],
  );

  // Back and forward to a note stay on the client. Next restores the history
  // entry's route tree; the host follows the URL. To any other route the
  // router leads, and the host lets go when it gets there.
  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname;
      const id = notePathId(path);
      const here = rendered.current;
      if (!id || id === here.shownId) return;
      if (!has(id)) {
        // Deleted since, or another workspace's: the server decides.
        navigate(path);
        return;
      }
      step({ type: "popstate", id, fromNote: here.shownId !== null });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [has, navigate, step]);

  const seed = useCallback(
    (snapshot: NoteSnapshot, docId: string) => {
      const before = storeRef.current;
      const fresh = before.workspaceId !== snapshot.workspaceId || snapshot.loadedAt >= before.loadedAt;
      update((store) => seedNotes(store, snapshot));
      // The shell still shows another workspace: WorkspaceGuard refreshes it,
      // and this runs again once it has.
      if (snapshot.workspaceId !== workspaceId) return;
      const location = window.location.pathname;
      if (location === `/vault/${docId}` && !has(docId)) {
        // A page brought back from the router's cache, for a note this copy
        // no longer has: ask the server again.
        if (!isNavigating()) navigate(location);
        return;
      }
      step({ type: "seed", id: docId, location, fresh });
    },
    [has, isNavigating, navigate, step, update, workspaceId],
  );

  const reread = useCallback<Reread>(
    async (id) => {
      const row = await readRow(id, workspaceId);
      if (row) update((store) => takeRow(store, id, row));
      if (row === null) {
        // Deleted, or no longer this workspace's: the server says which (a
        // 404, or the workspace it is in now).
        update((store) => dropNote(store, id));
        if (hostRef.current.trusted?.id === id) navigate(`/vault/${id}`);
      }
      return row;
    },
    [navigate, update, workspaceId],
  );

  const leave = useCallback(
    (id: string, copy: EditorCopy | Promise<EditorCopy>) => {
      // Nothing was left to save (also React's development double mount):
      // the copy is current at once, and the note never hides.
      if (!(copy instanceof Promise)) {
        update((store) => keepEditorCopy(store, id, copy));
        return;
      }
      // Hidden until the save settles, which it does within the saver's
      // LEAVE_TIMEOUT_MS: a save that times out counts as failed, and its
      // text comes back as unsaved.
      setLeaving((ids) => new Set(ids).add(id));
      void copy
        .then((settled) => update((store) => keepEditorCopy(store, id, settled)))
        .finally(() =>
          setLeaving((ids) => {
            const next = new Set(ids);
            next.delete(id);
            return next;
          }),
        );
    },
    [update],
  );

  const renamed = useCallback(
    (id: string, next: { title: string; markdown?: string; version?: number }) =>
      update((store) => takeRename(store, id, next)),
    [update],
  );
  const deleted = useCallback((id: string) => update((store) => dropNote(store, id)), [update]);

  const value = useMemo<NoteStoreValue>(
    () => ({
      shown,
      recheck: shown !== null && host.trusted?.recheck === true,
      docs: store.docs,
      unsaved: store.unsaved,
      open,
      seed,
      reread,
      leave,
      renamed,
      deleted,
    }),
    [shown, host, store, open, seed, reread, leave, renamed, deleted],
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

/** How long before a failed re-read is tried again. */
const REREAD_RETRY_MS = 500;

/**
 * For an editor opened from the copy (`docId`; null otherwise): whether its
 * row is still being read again. The editor stays read-only meanwhile, so no
 * save goes out on the copy's version before it is checked. A newer row
 * replaces the copy's text (`adopt`); a newer row under text a failed save
 * left gets the conflict banner (`conflict`). A failed read is tried once
 * more, then the row is loaded as Reload does; if that fails too, or would
 * replace unsaved text, the editor stays read-only.
 */
export function useCheckedCopy(
  docId: string | null,
  editor: {
    version: () => number;
    text: () => string;
    unsaved: () => boolean;
    adopt: (row: NoteRow) => void;
    conflict: () => void;
    reload: () => Promise<boolean>;
  },
): boolean {
  const reread = useContext(NoteStoreContext)?.reread;
  const [checking, setChecking] = useState(docId !== null && reread !== undefined);
  const latest = useRef(editor);
  useEffect(() => {
    latest.current = editor;
  });
  useEffect(() => {
    if (!docId || !reread) return;
    let live = true;
    void (async () => {
      let row = await reread(docId);
      if (row === undefined && live) {
        await new Promise((resolve) => setTimeout(resolve, REREAD_RETRY_MS));
        if (live) row = await reread(docId);
      }
      if (!live) return;
      const { version, text, unsaved, adopt, conflict, reload } = latest.current;
      if (row) {
        const verdict = refreshVerdict({ version: version(), text: text(), unsaved: unsaved() }, row);
        if (verdict === "adopt") adopt(row);
        else if (verdict === "conflict") conflict();
        setChecking(false);
        return;
      }
      // Gone: the server navigation the copy started takes over.
      if (row === null || unsaved()) return;
      if ((await reload()) && live) setChecking(false);
    })();
    return () => {
      live = false;
    };
  }, [docId, reread]);
  return checking;
}
