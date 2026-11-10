"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { EditorPane } from "@/components/vault/editor-pane";
import { RightPanel } from "@/components/vault/right-panel";
import { RegenerateDialog } from "@/components/vault/regenerate-dialog";
import { ShipPanel } from "@/components/vault/ship-panel";
import { SparklesIcon } from "lucide-react";
import { useIsCompactVault } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useVaultStatus } from "@/components/vault/vault-status";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useCheckedCopy, useOpenNote } from "@/components/vault/note-store";
import { resolveLinkTitle } from "@/lib/wikilinks";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { createNoteSaver } from "@/lib/note-saver";
import { useDocLock } from "@/hooks/use-doc-lock";
import type { LastSave } from "@/lib/doc-lock-client";
import { EditLockBanner } from "@/components/vault/edit-lock-banner";
import { EDITING_ELSEWHERE, editingMessage } from "@/lib/doc-lock";
import { useNoteTitle, useOverlaidNotes } from "@/components/vault/note-overlay";
import { useMindmapRebuild } from "@/components/vault/use-mindmap-rebuild";
import type { Doc } from "@/lib/types";
import type { EditorCopy, UnsavedText } from "@/lib/note-store";
import type { RenamedNote } from "@/lib/rename-note";
import { adoptRename } from "@/lib/rename-adopt";
import { useRegisterOpenNote } from "@/components/vault/open-note";
import type { EditorStats } from "@/lib/text-stats";
import { useHeadingRename } from "@/components/vault/use-heading-rename";
import { buildBacklinks } from "@/lib/wikilinks";
import { checkTitleLineSafety } from "@/components/vault/title-line-safety-reads";

const SETTLE_MS = 700;

/** The phone layout's views, in place of the desktop's side-by-side panes. */
type MobileView = "note" | "map" | "ship";

const MOBILE_VIEWS: { id: MobileView; label: string }[] = [
  { id: "note", label: "Note" },
  { id: "map", label: "Map" },
  { id: "ship", label: "Ship" },
];

/**
 * Owns the markdown for the active note. The markdown is the single source of
 * truth: the editor writes it, Supabase persists it, and both the graph and
 * the mindmap are derived from it — nothing else is stored.
 *
 * Mounted with `key={active.id}` by the vault's note host, so navigating
 * between notes remounts rather than reconciling stale editor state. Opened
 * from the vault's copy of the notes (DOQ-43, `recheck`), it stays read-only
 * until its row has been read again. Leaving, it saves what is typed before
 * its lock goes and hands the stored copy back (`onLeave`); text that save
 * could not store comes back as `unsaved`, and is never reloaded over.
 *
 * Edits are locked (WP-1.6, D-17): the first keystroke takes the note's edit
 * lock, and every save goes through /api/notes/[id] with the version the text
 * is based on. While someone else holds the lock the editor is read-only,
 * names them, and loads their text whenever its version moves on; an admin
 * may take the lock over. The lock belongs to this editor's edit session, so
 * a second tab of the same user is read-only too, with "Edit here". A save
 * the server refuses as stale is never retried over the newer text: the
 * editor stops and offers a reload, and nothing reloads on its own while
 * that offer stands, so the unsaved text stays put to be copied.
 *
 * Titles (this note's, and every other note's for the graph, backlinks and
 * [[wikilinks]]) are read through the vault's pending renames and deletes,
 * so a rename shows here in the same frame as in the explorer.
 */
export function DocWorkspace({
  docs: serverDocs,
  active,
  unsaved,
  recheck = false,
  onLeave,
}: {
  docs: Doc[];
  active: Doc;
  unsaved?: UnsavedText;
  recheck?: boolean;
  onLeave?: (copy: EditorCopy | Promise<EditorCopy>) => void;
}) {
  const router = useRouter();
  const docs = useOverlaidNotes(serverDocs);
  // Through the vault's pending renames (DOQ-32), so a rename from the
  // explorer shows here in the same frame; the heading renamer builds on it.
  const pageTitle = useNoteTitle(active.id, active.title);
  // One concept map for the note, shown by the right panel and the live
  // mindmap beside the editor alike: a rebuild from either shows in both.
  const concept = useMindmapRebuild({
    docId: active.id,
    stored: active.mindmap ?? null,
    stale: active.mindmapStale ?? false,
  });
  const { setWordCount, setSaveState, setEditorStats } = useVaultStatus();

  const [markdown, setMarkdown] = useState(unsaved?.text ?? active.markdown);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const isMobile = useIsCompactVault();
  const [mobileView, setMobileView] = useState<MobileView>("note");
  // A save was refused because someone else saved since this copy loaded.
  const [conflict, setConflict] = useState(false);
  // Read by the lock callbacks, which outlive a render.
  const conflictRef = useRef(conflict);
  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);
  const markdownRef = useRef(markdown);

  // The last save, run as the editor closes, before the lock is released.
  const lastSave = useRef<(() => LastSave | null) | null>(null);
  const { lock, controller } = useDocLock(active.id, lastSave);

  // Editing the title heading renames the note (DOQ-36).
  const headingRename = useHeadingRename({
    docId: active.id,
    title: pageTitle,
    initialMarkdown: active.markdown,
  });
  // Also where the editor reports the title line it added with a first edit
  // (D-120): saved with that edit, but the heading it adds says the title, so
  // the next heading check compares with it rather than with the text before.
  const resetHeading = headingRename.reset;

  // The page remounts this per note, so the saver never outlives its row.
  // Its writes hold the lock and send the version the text is based on.
  const [saver] = useState(() =>
    createNoteSaver({
      docId: active.id,
      markdown: active.markdown,
      version: unsaved?.version ?? active.version ?? 1,
      lock: controller,
      onConflict: () => setConflict(true),
    }),
  );
  const saves = saver.queue;
  // Text a failed last save left (DOQ-43): nothing reloads over it while it
  // is unsaved; when the note has moved on, the conflict banner says so.
  const [restored] = useState(unsaved !== undefined);
  const keepsUnsaved = useCallback(() => restored && markdownRef.current !== saves.saved, [restored, saves]);

  /** Makes `latest` the editor's text and its saved copy, at its version. */
  const adoptLatest = useCallback(
    (latest: { markdown: string; version: number }) => {
      saver.setVersion(latest.version);
      saves.markSaved(latest.markdown);
      markdownRef.current = latest.markdown;
      resetHeading(latest.markdown);
      setMarkdown(latest.markdown);
      setConflict(false);
      setSaveState("saved");
    },
    [resetHeading, saver, saves, setSaveState],
  );

  /** Replaces the editor's text with the stored note and its version; false when it could not. */
  const reloadLatest = useCallback(async (): Promise<boolean> => {
    const supabase = createSupabaseBrowserClient();
    const { data, error } = await supabase
      .from("documents")
      .select("markdown, version")
      .eq("id", active.id)
      .maybeSingle();
    if (error || !data) {
      toast.error("Could not load the latest version of this note");
      return false;
    }
    adoptLatest({ markdown: data.markdown, version: Number(data.version) });
    return true;
  }, [active.id, adoptLatest]);

  // Opened from the vault's copy: no save goes out on its version before the
  // row has been read again (DOQ-43).
  const checking = useCheckedCopy(recheck ? active.id : null, {
    version: () => saver.version,
    text: () => markdownRef.current,
    unsaved: () => markdownRef.current !== saves.saved,
    adopt: adoptLatest,
    conflict: () => setConflict(true),
    reload: reloadLatest,
  });
  // Read by the lock callbacks: while the row is read again, that read
  // decides which version the editor starts on.
  const checkingRef = useRef(checking);
  useEffect(() => {
    checkingRef.current = checking;
  }, [checking]);

  useEffect(() => {
    controller.setHandlers({
      onStatus: (status) => {
        if (status.version === saver.version) return;
        // The conflict banner asked the user to copy their text first; only
        // its Reload button replaces it.
        if (conflictRef.current || checkingRef.current) return;
        if (keepsUnsaved()) {
          setConflict(true);
          return;
        }
        // Someone else's save moved the note on. Load it, unless this user
        // holds the lock with edits not yet saved: those are theirs, and
        // the version check refuses their save if it would overwrite.
        if (status.mine && markdownRef.current !== saves.saved) return;
        void reloadLatest();
      },
      onLost: (status) => {
        const who = status.mineElsewhere ? EDITING_ELSEWHERE : editingMessage(status.holderName);
        toast.info(`${who} now. This copy is read-only.`);
        if (!conflictRef.current && !keepsUnsaved()) void reloadLatest();
      },
    });
  }, [controller, keepsUnsaved, reloadLatest, saver, saves]);

  const readOnly =
    conflict ||
    checking ||
    !lock.canEdit ||
    lock.phase === "loading" ||
    lock.phase === "other" ||
    lock.phase === "elsewhere";
  // Read-only only because the lock's status has not arrived yet (DOQ-17),
  // or the row is still being read again (DOQ-43): the editor keeps its
  // caret so typing works the moment it does.
  const lockPending = (lock.phase === "loading" || checking) && !conflict;
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  // Leaving (DOQ-43): what is typed is saved with the lock still held, and
  // the vault's copy takes the stored text, version and map once that save
  // settles. Text it could not store stays with the copy.
  const leaveRef = useRef(onLeave);
  useEffect(() => {
    leaveRef.current = onLeave;
    lastSave.current = () => {
      const text = markdownRef.current;
      const copy = (): EditorCopy => ({
        saved: saves.saved,
        version: saver.version,
        mindmap: concept.mindmap,
        // Text saved since the map's staleness was decided may not match it.
        mindmapStale: concept.mindmap !== null && (concept.stale || saves.saved !== active.markdown),
        unsaved: text === saves.saved ? undefined : { text, version: saver.version },
        restored: unsaved,
      });
      if (text === saves.saved || readOnlyRef.current) {
        leaveRef.current?.(copy());
        return null;
      }
      const leaving = saver.leave(text);
      // Settles either way: the copy says what the save could not store.
      const done = leaving.done.then(copy, copy);
      leaveRef.current?.(done);
      return { done, outlivesPage: leaving.outlivesPage };
    };
  });

  /** The editor's onChange: the first edit takes the lock. */
  const handleChange = useCallback(
    (next: string) => {
      // Now rather than after the render, for a title-line check made in the
      // same editor update (DOQ-36).
      markdownRef.current = next;
      setMarkdown(next);
      void controller.noteEdit().then((held) => {
        // Lost the race for a free lock: drop the keystroke for their text.
        const { phase } = controller.getState();
        if (!held && (phase === "other" || phase === "elsewhere") && !keepsUnsaved()) void reloadLatest();
      });
    },
    [controller, keepsUnsaved, reloadLatest],
  );

  const handleTakeOver = useCallback(async () => {
    if (await controller.takeOver()) {
      // Nobody else can save now, so the text loaded here is the latest.
      if (!keepsUnsaved()) await reloadLatest();
      toast.success("You are editing this note now");
    } else {
      toast.error(controller.getState().error ?? "Could not take over this note");
    }
  }, [controller, keepsUnsaved, reloadLatest]);

  const lockBanner = (
    <EditLockBanner
      lock={lock}
      conflict={conflict}
      onTakeOver={() => void handleTakeOver()}
      onReload={() => void reloadLatest()}
    />
  );

  // Keeps the Supabase write and the force simulation off the keystroke path.
  const settled = useDebouncedValue(markdown, SETTLE_MS);

  // The status bar's counts come from the editor, which has the note's
  // parse tree already (lib/text-stats.ts); a same-number word count
  // re-renders nothing.
  const handleStats = useCallback(
    (stats: EditorStats) => {
      setEditorStats(stats);
      setWordCount(stats.words);
    },
    [setEditorStats, setWordCount],
  );

  useEffect(() => {
    markdownRef.current = markdown;
    if (markdown !== saves.saved) setSaveState("saving");
  }, [markdown, saves, setSaveState]);

  // Clear the shared status when leaving the note.
  useEffect(() => {
    return () => {
      setWordCount(undefined);
      setSaveState("idle");
      setEditorStats(undefined);
    };
  }, [setWordCount, setSaveState, setEditorStats]);

  useEffect(() => {
    if (settled === saves.saved) return;
    // A read-only copy has nothing of its own to save; a keystroke that lost
    // the race for the lock is about to be replaced by the holder's text.
    if (readOnly) return;
    // Text the editor no longer holds, e.g. the copy's from before a newer
    // row was adopted (DOQ-43): the debounce brings the current text next.
    if (settled !== markdownRef.current) return;

    let cancelled = false;

    saves.save(settled).then(
      () => {
        if (!cancelled) setSaveState("saved");
      },
      (e: unknown) => {
        if (cancelled) return;
        setSaveState("error");
        toast.error(e instanceof Error ? e.message : "Could not save");
      },
    );

    return () => {
      cancelled = true;
    };
  }, [settled, saves, setSaveState, readOnly]);

  /**
   * Writes the editor's text now instead of waiting for the debounce, and
   * returns exactly what was stored — the ship panel hashes that, so the
   * on-chain hash always matches a row Supabase actually holds.
   */
  const saveNow = useCallback(async () => {
    const text = markdownRef.current;
    try {
      await saves.save(text);
    } catch (e) {
      setSaveState("error");
      throw e;
    }
    setSaveState(markdownRef.current === text ? "saved" : "saving");
    return text;
  }, [saves, setSaveState]);

  /**
   * Renames this note, for the shell's rename dialog (DOQ-35). The rename may
   * rewrite the note's title heading on the server, so edits not yet saved
   * are saved first (the server rewrites the text shown here, and nothing
   * typed is lost), and the request runs in the save queue, so no autosave
   * races it. The text it wrote then becomes the saved copy at its version,
   * as for Regenerate, and the next save goes on from there. Anything typed
   * while it ran is kept, with the same heading change made to it
   * (lib/rename-adopt.ts), and an autosave queued meanwhile saves that text,
   * not the pre-rename one it was queued with (SaveQueue.run).
   *
   * The request names this editor's edit session, so the server lets the
   * heading change only when this tab holds the lock, or nobody does
   * (rename_document()).
   */
  const noteRenamed = headingRename.noteRenamed;
  const renameHere = useCallback(
    async (request: (session: string) => Promise<RenamedNote>) => {
      if (!readOnly) {
        try {
          await saveNow();
        } catch (e) {
          const reason = e instanceof Error ? ` ${e.message}` : "";
          throw new Error(`Your edits could not be saved, so the note was not renamed.${reason}`);
        }
      }
      return saves.run(async () => {
        const renamed = await request(controller.session);
        const adopted = adoptRename({
          renamed,
          editorVersion: saver.version,
          saved: saves.saved,
          current: markdownRef.current,
        });
        noteRenamed(renamed, adopted?.text);
        if (!adopted) {
          // A rewrite this copy was already behind: load what the note is
          // now, unless it holds unsaved text or a conflict the user must see.
          if (renamed.markdown !== undefined && !conflictRef.current && markdownRef.current === saves.saved) {
            void reloadLatest();
          }
          return renamed;
        }
        saver.setVersion(adopted.version);
        saves.markSaved(adopted.saved);
        markdownRef.current = adopted.text;
        setMarkdown(adopted.text);
        setSaveState(adopted.text === adopted.saved ? "saved" : "saving");
        return renamed;
        // An autosave queued while this ran writes the editor's text as it is
        // now, rebased, rather than the pre-rename text it was queued with.
      }, () => markdownRef.current);
    },
    [controller, noteRenamed, readOnly, reloadLatest, saveNow, saver, saves, setSaveState],
  );
  // Registered with the shell, so its rename dialog renames this note here.
  const openHere = useMemo(() => ({ docId: active.id, rename: renameHere }), [active.id, renameHere]);
  useRegisterOpenNote(openHere);

  /**
   * Renames the note when its title heading was edited (DOQ-36): when an
   * edit settles, and when the caret leaves the title line. Never while the
   * copy is read-only or its lock is loading. The explorer, tab, graph and
   * mindmap read the title from the layout's server data, as after a rename
   * from the explorer.
   */
  const checkHeadingNow = headingRename.check;
  const checkHeading = useCallback(() => {
    checkHeadingNow({
      text: () => markdownRef.current,
      canRename: () => !readOnlyRef.current,
      rename: renameHere,
      backlinks: () => buildBacklinks(docs, active.id).length,
      refresh: () => router.refresh(),
    });
  }, [checkHeadingNow, renameHere, docs, active.id, router]);
  const checkHeadingRef = useRef(checkHeading);
  useEffect(() => {
    checkHeadingRef.current = checkHeading;
  }, [checkHeading]);
  // Also once the copy can be edited again, for an edit that settled while
  // the lock's status was reloading.
  useEffect(() => {
    checkHeadingRef.current();
  }, [settled, readOnly]);
  // Called from inside an editor update: run once it has finished.
  const leaveTitleLine = useCallback(() => queueMicrotask(() => checkHeadingRef.current()), []);
  const title = headingRename.title;

  /**
   * The title line an older note gets after its first edit (D-120,
   * lib/title-line.ts), written by the editor (title-line-writer.ts). It asks
   * afresh, at that moment, whether the note's headings are linked or
   * anchored (lib/title-line-safety.ts), and writes with the title the page's
   * data confirms: not while a rename is still on its way.
   */
  const checkTitleLine = useCallback(() => checkTitleLineSafety(active.id), [active.id]);
  const titleLineWrite = useMemo(
    () => ({ title: title === active.title ? active.title : null, check: checkTitleLine }),
    [title, active.title, checkTitleLine],
  );

  /**
   * The graph reads the settled text so the simulation is not restarted on
   * every keystroke. The mindmap reads the live text — it is cheap DOM and
   * benefits from immediate feedback.
   */
  const docsForGraph = useMemo(
    () =>
      docs.map((doc) =>
        doc.id === active.id ? { ...doc, markdown: settled } : doc,
      ),
    [docs, active.id, settled],
  );

  // A followed [[link]] opens the note it names, as the graph would. A ghost
  // link names no note, and does nothing.
  const showNote = useOpenNote();
  const openNote = useCallback(
    (title: string) => {
      const target = resolveLinkTitle(docs, title);
      if (target && target.id !== active.id) showNote(target.id);
    },
    [docs, active.id, showNote],
  );

  // Every other note, offered by the editor's `[[` autocomplete.
  const linkTitles = useMemo(
    () => docs.filter((doc) => doc.id !== active.id).map((doc) => doc.title),
    [docs, active.id],
  );

  const handleRegenerate = useCallback(async () => {
    // Regenerating rewrites the note: it needs the lock, and the model must
    // see what the editor shows, so pending edits are saved first. ensure()
    // also counts as activity, so the idle timer does not let the lock go
    // while the model runs; the route renews it on the server.
    if (!(await controller.ensure())) {
      const { phase, holderName } = controller.getState();
      toast.error(phase === "elsewhere" ? EDITING_ELSEWHERE : editingMessage(holderName));
      return;
    }
    try {
      await saveNow();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save before regenerating");
      return;
    }

    const res = await fetch("/api/regenerate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: active.id, session: controller.session }),
    });

    const payload: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error: unknown }).error)
          : `Regenerate failed (${res.status})`;
      toast.error(message);
      return;
    }

    const next =
      payload && typeof payload === "object" && "markdown" in payload
        ? String((payload as { markdown: unknown }).markdown)
        : null;

    if (next === null) {
      toast.error("Regenerate returned no markdown");
      return;
    }

    // The route already wrote this row, so adopt it as the saved baseline
    // rather than letting the debounced effect write it straight back.
    const nextVersion =
      payload && typeof payload === "object" && "version" in payload
        ? Number((payload as { version: unknown }).version)
        : NaN;
    if (Number.isSafeInteger(nextVersion)) saver.setVersion(nextVersion);
    saves.markSaved(next);
    markdownRef.current = next;
    resetHeading(next);
    setMarkdown(next);
    setSaveState("saved");
    toast.success("Note regenerated");
    router.refresh();
  }, [active.id, controller, resetHeading, router, saveNow, saver, saves, setSaveState]);

  const regenerateDialog = (
    <RegenerateDialog
      open={regenerateOpen}
      onOpenChange={setRegenerateOpen}
      onConfirm={handleRegenerate}
    />
  );

  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-border bg-background flex h-12 shrink-0 items-center gap-2 border-b px-2">
          <div
            role="tablist"
            aria-label="Note views"
            className="grid h-9 flex-1 grid-cols-3 rounded-xl border border-[var(--glass-lo)] bg-black/30 p-[3px] sm:max-w-sm"
          >
            {MOBILE_VIEWS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mobileView === id}
                onClick={() => setMobileView(id)}
                className={cn(
                  "focus-visible:ring-ring rounded-[9px] border text-[13px] font-medium transition-colors focus-visible:ring-1 focus-visible:outline-hidden",
                  mobileView === id
                    ? "text-foreground border-[var(--glass-lo)] bg-[var(--glass-strong)] shadow-[inset_0_1px_0_0_var(--glass-hi)]"
                    : "text-muted-foreground border-transparent active:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Regenerate with AI"
            onClick={() => setRegenerateOpen(true)}
            // The muted lavender is reserved for AI-driven affordances.
            className="icon-tile text-accent focus-visible:ring-ring ml-auto size-9 transition-colors active:bg-[var(--glass-strong)] focus-visible:ring-1 focus-visible:outline-hidden"
          >
            <SparklesIcon className="size-[18px]" strokeWidth={1.5} />
          </button>
        </div>

        {/*
          The editor stays mounted while hidden so switching views keeps its
          caret and scroll; the graph is unmounted so its simulation stops.
        */}
        <div className={cn("min-h-0 flex-1", mobileView !== "note" && "hidden")}>
          <EditorPane
            compact
            title={title}
            concept={concept}
            markdown={markdown}
            onChange={handleChange}
            onRegenerate={() => setRegenerateOpen(true)}
            linkTitles={linkTitles}
            readOnly={readOnly}
            pending={lockPending}
            onOpenNote={openNote}
            onStats={handleStats}
            banner={lockBanner}
            headingNotice={headingRename.notice}
            onDismissHeadingNotice={headingRename.dismiss}
            onLeaveTitleLine={leaveTitleLine}
            onTitleLine={resetHeading}
            titleLineWrite={titleLineWrite}
          />
        </div>
        {mobileView === "map" && (
          <div className="min-h-0 flex-1">
            <RightPanel
              docs={docsForGraph}
              activeId={active.id}
              title={title}
              markdown={markdown}
              concept={concept}
              onSave={saveNow}
              showShip={false}
            />
          </div>
        )}
        {mobileView === "ship" && (
          <div className="bg-sidebar min-h-0 flex-1 overflow-y-auto [&>*:first-child]:border-t-0">
            <ShipPanel docId={active.id} title={title} markdown={markdown} onSave={saveNow} />
          </div>
        )}

        {regenerateDialog}
      </div>
    );
  }

  return (
    <>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0">
        <ResizablePanel id="editor" minSize={320} className="flex min-h-0 flex-col">
          <EditorPane
            title={title}
            concept={concept}
            markdown={markdown}
            onChange={handleChange}
            onRegenerate={() => setRegenerateOpen(true)}
            linkTitles={linkTitles}
            readOnly={readOnly}
            pending={lockPending}
            onOpenNote={openNote}
            onStats={handleStats}
            banner={lockBanner}
            headingNotice={headingRename.notice}
            onDismissHeadingNotice={headingRename.dismiss}
            onLeaveTitleLine={leaveTitleLine}
            onTitleLine={resetHeading}
            titleLineWrite={titleLineWrite}
          />
        </ResizablePanel>

        <ResizableHandle className="hover:bg-foreground/25 transition-colors" />

        <ResizablePanel
          id="right"
          defaultSize={250}
          minSize={200}
          maxSize={460}
          className="min-h-0"
        >
          <RightPanel
            docs={docsForGraph}
            activeId={active.id}
            title={title}
            markdown={markdown}
            concept={concept}
            onSave={saveNow}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      {regenerateDialog}
    </>
  );
}
