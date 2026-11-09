"use client";

import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, Prec, Transaction, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redoDepth, undoDepth } from "@codemirror/commands";
import { searchPanelOpen } from "@codemirror/search";
import { syntaxTree } from "@codemirror/language";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { cn } from "@/lib/utils";
import { PREVIEW_MARKDOWN_EXTENSIONS } from "@/lib/live-preview/syntax";
import { formatState, NO_FORMAT, type FormatState } from "@/lib/live-preview/commands";
import { countWords, type EditorStats } from "@/lib/text-stats";
import { livePreview } from "@/components/vault/live-editor/live-preview";
import { editorTheme } from "@/components/vault/live-editor/theme";
import { wikilinkCompletion } from "@/components/vault/live-editor/wikilink-completion";
import { linkFollowing, noteOpener } from "@/components/vault/live-editor/link-following";
import { external, readOnlyGuard } from "@/components/vault/live-editor/read-only";
import { findAndReplace, formattingKeymap, searchKeymap } from "@/components/vault/live-editor/editor-actions";
import { FormatToolbar, type EditorMode } from "@/components/vault/live-editor/format-toolbar";

/** The smallest single change that turns `from` into `to`. */
function diff(from: string, to: string) {
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let endFrom = from.length;
  let endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom--;
    endTo--;
  }
  return { from: start, to: endFrom, insert: to.slice(start, endTo) };
}

/*
 * The view (Source, Live or Reading) is a per-browser choice, Live by
 * default. Storage can be unavailable (private windows, blocked site data);
 * the switch then still works for the session, it just is not kept.
 */
const VIEW_KEY = "doqtri:editor-view";

function storedMode(): EditorMode {
  try {
    const stored = window.localStorage.getItem(VIEW_KEY);
    return stored === "source" || stored === "reading" ? stored : "live";
  } catch {
    return "live";
  }
}

function storeMode(mode: EditorMode) {
  try {
    window.localStorage.setItem(VIEW_KEY, mode);
  } catch {
    // Kept for this session only; see above.
  }
}

/** What the toolbar shows, read off the editor after each change. */
type Snapshot = { formats: FormatState; canUndo: boolean; canRedo: boolean; searchOpen: boolean };

const EMPTY: Snapshot = { formats: NO_FORMAT, canUndo: false, canRedo: false, searchOpen: false };

function snapshotOf(state: EditorState): Snapshot {
  return {
    formats: formatState(state, syntaxTree(state)),
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
    searchOpen: searchPanelOpen(state),
  };
}

function statsOf(state: EditorState): EditorStats {
  const { main } = state.selection;
  const line = state.doc.lineAt(main.head);
  return {
    chars: state.doc.length,
    line: line.number,
    col: main.head - line.from + 1,
    selection: main.empty ? null : { words: countWords(state.sliceDoc(main.from, main.to)), chars: main.to - main.from },
  };
}

/**
 * The note editor: one column of markdown that reads as rendered text, with
 * the raw source shown only on the lines being edited (see live-preview.ts).
 *
 * The document is the markdown string and nothing else — `onChange` receives
 * it whole after every edit, exactly as typed, and a new `value` from outside
 * (a reload, a regenerate) replaces it. There is no rich-text model to drift
 * from what is saved and hashed.
 *
 * Three views of the same text: Source (the raw markdown everywhere), Live
 * (the default above) and Reading (everything rendered, no caret, links open
 * on a plain click). A note that cannot be edited always reads as Live does
 * without a caret, and shows no toolbar.
 *
 * Browser-only (CodeMirror measures the DOM), so EditorPane loads it with
 * `next/dynamic` and `ssr: false`.
 */
export default function MarkdownEditor({
  value,
  onChange,
  linkTitles,
  readOnly,
  pending = false,
  placeholder,
  compact = false,
  autoHeight = false,
  onOpenNote,
  onStats,
}: {
  value: string;
  onChange: (markdown: string) => void;
  /** Titles offered when a `[[link` is being typed. */
  linkTitles: string[];
  /** No edits and no toolbar; tables and images stay rendered. */
  readOnly: boolean;
  /**
   * Read-only only until the edit lock's status arrives: the editor keeps
   * its focus and caret, so typing works the moment the lock allows it.
   */
  pending?: boolean;
  placeholder: string;
  /** Phone layout: finger-sized toolbar that scrolls sideways. */
  compact?: boolean;
  /** Grow with the text instead of filling and scrolling (the demo's read-only note). */
  autoHeight?: boolean;
  /** Opens the note a followed `[[wikilink]]` names; none, and wikilinks do not open. */
  onOpenNote?: (title: string) => void;
  /** Characters, caret position and selection counts, for the status bar. */
  onStats?: (stats: EditorStats) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [lock] = useState(() => new Compartment());
  const [preview] = useState(() => new Compartment());
  // One instance per view, so switching back keeps the preview's state.
  const [views] = useState<Record<EditorMode, Extension>>(() => {
    const rendered = livePreview();
    return {
      source: EditorView.editorAttributes.of({ class: "cm-source-view" }),
      live: rendered,
      reading: rendered,
    };
  });
  const [mode, setMode] = useState<EditorMode>(storedMode);
  const [fullscreen, setFullscreen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  // A note nobody may edit reads rendered whatever the chosen view (but
  // one waiting for its lock already shows the view it will be edited in).
  const shownMode: EditorMode = readOnly && !pending ? "live" : mode;

  // Read by CodeMirror callbacks, which outlive a render.
  const onChangeRef = useRef(onChange);
  const titlesRef = useRef(linkTitles);
  const openNoteRef = useRef(onOpenNote);
  const statsRef = useRef(onStats);
  /** The text this editor last reported, so its own echo is not re-applied. */
  const reportedRef = useRef(value);
  useEffect(() => {
    onChangeRef.current = onChange;
    titlesRef.current = linkTitles;
    openNoteRef.current = onOpenNote;
    statsRef.current = onStats;
  });

  /** Reading is read-only too: nothing in it may change the text. */
  const lockExtensions = (locked: boolean, focusable: boolean, reading: boolean) => [
    EditorState.readOnly.of(locked || reading),
    EditorView.editable.of(!reading && (!locked || focusable)),
  ];

  // Built once; later prop changes go through the compartments and the
  // value effect below rather than rebuilding the editor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let lastSnapshot = "";
    let lastStats = "";
    const report = (state: EditorState, docOrSelection: boolean) => {
      const next = snapshotOf(state);
      const key = JSON.stringify(next);
      if (key !== lastSnapshot) {
        lastSnapshot = key;
        setSnapshot(next);
      }
      if (!docOrSelection) return;
      const stats = statsOf(state);
      const statsKey = JSON.stringify(stats);
      if (statsKey !== lastStats) {
        lastStats = statsKey;
        statsRef.current?.(stats);
      }
    };
    const created = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: reportedRef.current,
        extensions: [
          lock.of(lockExtensions(readOnly, pending, shownMode === "reading")),
          history(),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          placeholderText(placeholder),
          markdown({
            base: commonmarkLanguage,
            extensions: PREVIEW_MARKDOWN_EXTENSIONS,
            completeHTMLTags: false,
          }),
          preview.of(views[shownMode]),
          linkFollowing(),
          noteOpener.of((title) => openNoteRef.current?.(title)),
          wikilinkCompletion(() => titlesRef.current),
          findAndReplace(),
          Prec.high(keymap.of(formattingKeymap)),
          keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({
            "aria-label": "Note text",
            spellcheck: "false",
            autocorrect: "off",
          }),
          editorTheme,
          readOnlyGuard,
          EditorView.updateListener.of((update) => {
            // Scrolling and measuring change nothing the toolbar shows.
            if (update.transactions.length > 0) report(update.state, update.docChanged || update.selectionSet);
            if (!update.docChanged) return;
            if (update.transactions.every((tr) => tr.annotation(external))) return;
            if (update.startState.readOnly) return;
            const text = update.state.doc.toString();
            reportedRef.current = text;
            onChangeRef.current(text);
          }),
        ],
      }),
    });
    // For the end-to-end tests (e2e/helpers.ts), which run against `next dev`:
    // the rendered text hides the markdown syntax, so the document can only
    // be read from the view. Never in a production build.
    if (process.env.NODE_ENV !== "production") {
      Object.defineProperty(created.dom, "__doqtriEditor", { value: created });
    }
    report(created.state, true);
    setView(created);
    return () => {
      created.destroy();
      setView(null);
    };
    // Mount only: see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view?.dispatch({
      effects: [
        lock.reconfigure(lockExtensions(readOnly, pending, shownMode === "reading")),
        preview.reconfigure(views[shownMode]),
      ],
    });
  }, [view, lock, preview, views, readOnly, pending, shownMode]);

  // Text from outside: a reload after a conflict, someone else's save, a
  // regenerate. Applied as the smallest change, so the caret stays put when
  // the edit is elsewhere, and kept out of undo history — undoing into text
  // the server has moved past would only start a conflict.
  useEffect(() => {
    if (!view || value === reportedRef.current) return;
    const current = view.state.doc.toString();
    reportedRef.current = value;
    if (current === value) return;
    view.dispatch({
      changes: diff(current, value),
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }, [view, value]);

  // Full screen ends on Esc — unless Esc is closing something first: the
  // find panel, the link list, or a menu or popover (focused outside this
  // element). Seen before anyone handles it, since a tooltip that happens
  // to be showing takes the key for itself.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const root = rootRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (target && target !== document.body && !root?.contains(target)) return;
      if (target?.closest(".cm-panels") || root?.querySelector(".cm-tooltip-autocomplete")) return;
      setFullscreen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

  const changeMode = (next: EditorMode) => {
    setMode(next);
    storeMode(next);
  };

  return (
    <div
      ref={rootRef}
      data-view={shownMode}
      data-fullscreen={fullscreen || undefined}
      className={cn(
        "doqtri-editor flex flex-col",
        !autoHeight && "h-full min-h-0",
        fullscreen && "bg-background fixed inset-0 z-50 h-dvh",
      )}
    >
      {/* Drawn before the editor exists too, so the text never shifts down under it. */}
      {/* While the lock loads it shows, disabled, so it never pops in and pushes the text down. */}
      {(!readOnly || pending) && (
        <FormatToolbar
          view={view}
          formats={snapshot.formats}
          canUndo={snapshot.canUndo}
          canRedo={snapshot.canRedo}
          searchOpen={snapshot.searchOpen}
          compact={compact}
          disabled={readOnly}
          mode={mode}
          onModeChange={changeMode}
          fullscreen={fullscreen}
          onFullscreenChange={setFullscreen}
        />
      )}
      <div ref={hostRef} className={cn(!autoHeight && "min-h-0 flex-1")} data-testid="note-editor" />
    </div>
  );
}
