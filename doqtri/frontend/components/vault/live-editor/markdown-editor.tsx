"use client";

import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { history, historyKeymap, redoDepth, undoDepth } from "@codemirror/commands";
import { searchPanelOpen } from "@codemirror/search";
import { syntaxTree } from "@codemirror/language";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { cn } from "@/lib/utils";
import { PREVIEW_MARKDOWN_EXTENSIONS } from "@/lib/live-preview/syntax";
import { formatState, NO_FORMAT, type FormatState } from "@/lib/live-preview/commands";
import { hiddenSyntax, renderedText, textCounts, type EditorStats } from "@/lib/text-stats";
import { livePreview } from "@/components/vault/live-editor/live-preview";
import { editorTheme } from "@/components/vault/live-editor/theme";
import { wikilinkCompletion } from "@/components/vault/live-editor/wikilink-completion";
import { linkFollowing, noteOpener } from "@/components/vault/live-editor/link-following";
import { external, readOnlyGuard } from "@/components/vault/live-editor/read-only";
import { editorKeymap, findAndReplace, searchKeymap, shortcutKeys } from "@/components/vault/live-editor/editor-actions";
import { FormatToolbar, type EditorMode } from "@/components/vault/live-editor/format-toolbar";
import { headingNotice, headingNoticeDismiss, setHeadingNotice } from "@/components/vault/live-editor/heading-notice";
import { headingNoticeText, type HeadingNotice } from "@/lib/heading-rename";
import { setNoteTitle, titleLine as titleLineGuard, titleLineChange } from "@/components/vault/live-editor/title-line";
import {
  createTitleLineWriter,
  type TitleLineWrite,
  type TitleLineWriter,
  type TitleLineWriterState,
} from "@/components/vault/live-editor/title-line-writer";

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

/** What Tab can reach inside full screen. */
const TABBABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex], [contenteditable="true"]';

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

/** How long typing pauses before the whole note is counted again. */
const RECOUNT_MS = 200;

/**
 * The status bar's counts, of the rendered text (lib/text-stats.ts). The
 * caret's place and a selection's counts are live; the whole note's words
 * and characters are counted again once typing pauses, since that walks
 * the whole parse tree.
 */
function statsReporter(emit: (stats: EditorStats) => void, current: () => EditorState | null) {
  let note: { words: number; chars: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  const countNote = (state: EditorState) => {
    const text = state.doc.toString();
    note = textCounts(renderedText(text, hiddenSyntax(syntaxTree(state), text)));
  };
  const send = (state: EditorState) => {
    if (!note) return;
    const { main } = state.selection;
    const line = state.doc.lineAt(main.head);
    let selection: EditorStats["selection"] = null;
    if (!main.empty) {
      // Only the syntax around the selection: cheap however long the note.
      const text = state.doc.toString();
      selection = textCounts(renderedText(text, hiddenSyntax(syntaxTree(state), text, main.from, main.to), main.from, main.to));
    }
    const stats = { ...note, line: line.number, col: main.head - line.from + 1, selection };
    const key = JSON.stringify(stats);
    if (key === last) return;
    last = key;
    emit(stats);
  };
  return {
    /** Counts everything now: when the editor opens. */
    now(state: EditorState) {
      countNote(state);
      send(state);
    },
    /** After an update: the caret now, the note once typing pauses. */
    update(state: EditorState, noteChanged: boolean) {
      if (noteChanged) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const latest = current();
          if (!latest) return;
          countNote(latest);
          send(latest);
        }, RECOUNT_MS);
      }
      send(state);
    },
    destroy() {
      clearTimeout(timer);
    },
  };
}
/** The number of the note's first non-blank line, where its title heading would be. */
function titleLine(state: EditorState): number | null {
  const { doc } = state;
  for (let n = 1; n <= doc.lines; n++) {
    if (!/^[ \t\f\v]*$/.test(doc.line(n).text)) return n;
  }
  return null;
}

/** Whether the caret is on the title line. */
function caretOnTitleLine(state: EditorState): boolean {
  const line = titleLine(state);
  return line !== null && state.doc.lineAt(state.selection.main.head).number === line;
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
 * Given the note's `title`, its first line is the title line (D-120,
 * title-line.ts): always `# <title>`, kept in place while editing. Opening a
 * note writes nothing. A note that does not open with its title line shows
 * it above the text, display only, and gets the real one after its first
 * edit, when a fresh `titleLineWrite.check()` allows it (title-line-writer.ts):
 * `# <title>` goes in as its own change at the top, outside undo history, so
 * the edit lands where it was made and undoing it leaves the line. Text
 * loaded from outside that lacks the line (a Regenerate) gets it after the
 * next edit, the same way.
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
  headingNotice: notice = null,
  onDismissHeadingNotice,
  onLeaveTitleLine,
  title,
  onTitleLine,
  titleLineWrite,
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
  /** The line under the title heading (DOQ-36): a title clash, or a rename's links; null for none. */
  headingNotice?: HeadingNotice | null;
  /** The notice's Dismiss button. */
  onDismissHeadingNotice?: () => void;
  /** The caret moved off the note's first non-blank line, after an edit or by moving (DOQ-36). */
  onLeaveTitleLine?: () => void;
  /**
   * The note's title: turns on the title line (D-120). Whether there is one
   * is read once, when the editor is made; the title itself may change.
   */
  title?: string;
  /** The editor just put the title line in, with this text; `onChange` has already had it. */
  onTitleLine?: (markdown: string) => void;
  /**
   * How a note that lacks its title line gets it after its first edit: the
   * confirmed title (null while a rename is on its way), and the fresh check
   * of whether it may (title-line-writer.ts).
   */
  titleLineWrite?: TitleLineWrite;
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
  // A copy that turns read-only (someone took the lock over) leaves full
  // screen at once: its toolbar, and so the way out, goes, and the lock
  // banner with Take over is behind the overlay.
  if (fullscreen && readOnly && !pending) setFullscreen(false);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  // A note nobody may edit reads rendered whatever the chosen view (but
  // one waiting for its lock already shows the view it will be edited in).
  const shownMode: EditorMode = readOnly && !pending ? "live" : mode;

  // Read by CodeMirror callbacks, which outlive a render.
  const onChangeRef = useRef(onChange);
  const titlesRef = useRef(linkTitles);
  const openNoteRef = useRef(onOpenNote);
  const statsRef = useRef(onStats);
  const dismissRef = useRef(onDismissHeadingNotice);
  const leaveTitleRef = useRef(onLeaveTitleLine);
  const titleRef = useRef(title);
  const titleLineRef = useRef(onTitleLine);
  /** The text this editor last reported, so its own echo is not re-applied. */
  const reportedRef = useRef(value);
  const titleWriteRef = useRef(titleLineWrite);
  const [titleLineState, setTitleLineState] = useState<TitleLineWriterState>("idle");
  /** Gives an older note its title line after its first edit; made with the editor. */
  const titleWriterRef = useRef<TitleLineWriter | null>(null);
  useEffect(() => {
    onChangeRef.current = onChange;
    titlesRef.current = linkTitles;
    openNoteRef.current = onOpenNote;
    statsRef.current = onStats;
    dismissRef.current = onDismissHeadingNotice;
    leaveTitleRef.current = onLeaveTitleLine;
    titleRef.current = title;
    titleLineRef.current = onTitleLine;
    titleWriteRef.current = titleLineWrite;
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
    let created: EditorView | null = null;
    const stats = statsReporter(
      (next) => statsRef.current?.(next),
      () => created?.state ?? null,
    );
    const report = (state: EditorState, noteChanged: boolean, selectionChanged: boolean) => {
      const next = snapshotOf(state);
      const key = JSON.stringify(next);
      if (key !== lastSnapshot) {
        lastSnapshot = key;
        setSnapshot(next);
      }
      if (noteChanged || selectionChanged) stats.update(state, noteChanged);
    };
    // It reads the workspace's word when an edit asks.
    const titleWriter = createTitleLineWriter({
      write: () => (titleRef.current === undefined ? undefined : titleWriteRef.current),
      onAdded: (markdown) => titleLineRef.current?.(markdown),
      onState: setTitleLineState,
    });
    titleWriterRef.current = titleWriter;
    created = new EditorView({
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
          shortcutKeys(),
          keymap.of([...searchKeymap, ...editorKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({
            "aria-label": "Note text",
            spellcheck: "false",
            autocorrect: "off",
          }),
          headingNotice(),
          headingNoticeDismiss.of(() => dismissRef.current?.()),
          titleRef.current === undefined ? [] : titleLineGuard(titleRef.current),
          editorTheme,
          readOnlyGuard,
          EditorView.updateListener.of((update) => {
            // Scrolling and measuring change nothing the toolbar shows.
            if (update.transactions.length > 0) {
              const noteChanged = update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state);
              report(update.state, noteChanged, update.selectionSet);
            }
            if (!update.docChanged) return;
            if (update.transactions.every((tr) => tr.annotation(external))) return;
            if (update.startState.readOnly) return;
            const text = update.state.doc.toString();
            reportedRef.current = text;
            onChangeRef.current(text);
          }),
          // The note's first edit brings its title line, when it has none yet.
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.startState.readOnly) return;
            if (update.transactions.every((tr) => tr.annotation(external) || tr.annotation(titleLineChange))) return;
            titleWriter.edited(update.view);
          }),
          // Reported after the change above, so the text it acts on is the edited one.
          EditorView.updateListener.of((update) => {
            if (!update.selectionSet && !update.docChanged) return;
            if (update.state.readOnly) return;
            if (update.transactions.every((tr) => tr.annotation(external))) return;
            if (caretOnTitleLine(update.startState) && !caretOnTitleLine(update.state)) leaveTitleRef.current?.();
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
    report(created.state, false, false);
    stats.now(created.state);
    const mounted = created;
    setView(mounted);
    return () => {
      stats.destroy();
      mounted.destroy();
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

  useEffect(() => {
    view?.dispatch({ effects: setHeadingNotice.of(notice) });
  }, [view, notice]);

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
    // Text that lacks the title line gets it after the next edit (D-120).
    titleWriterRef.current?.reset();
  }, [view, value]);

  useEffect(() => {
    if (view && title !== undefined) view.dispatch({ effects: setNoteTitle.of(title) });
  }, [view, title]);

  // Full screen ends on Esc — unless Esc is closing something first: the
  // find panel, the link list, or a menu or popover (focused outside this
  // element). Seen before anyone handles it, since a tooltip that happens
  // to be showing takes the key for itself.
  useEffect(() => {
    if (!fullscreen || !view) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && target !== document.body && !rootRef.current?.contains(target)) return;
      // The link list shows as a tooltip only while it has notes to offer.
      if (searchPanelOpen(view.state) || view.dom.querySelector(".cm-tooltip-autocomplete")) return;
      setFullscreen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen, view]);

  // Full screen is modal: everything else on the page is inert (out of
  // reach of Tab and the pointer) until it ends, and focus goes back where
  // it was. Menus and popovers opened from the editor portal in afterwards,
  // so they stay usable.
  useEffect(() => {
    const root = rootRef.current;
    if (!fullscreen || !root) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const made: HTMLElement[] = [];
    for (let node: HTMLElement = root; node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || !(sibling instanceof HTMLElement) || sibling.hasAttribute("inert")) continue;
        sibling.setAttribute("inert", "");
        made.push(sibling);
      }
    }
    if (!root.contains(document.activeElement)) view?.focus();
    // Tab and Shift+Tab wrap around inside, rather than leave for the browser's own controls.
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !root.contains(document.activeElement)) return;
      // The text itself is a stop too, though it reports no tabIndex.
      const stops = [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
        (el) =>
          (el.tabIndex >= 0 || el.isContentEditable) &&
          el.getAttribute("tabindex") !== "-1" &&
          el.getClientRects().length > 0,
      );
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (event.shiftKey ? at === first : at === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onTab);
    return () => {
      document.removeEventListener("keydown", onTab);
      for (const element of made) element.removeAttribute("inert");
      // A frame later, once a lock change has made the text read-only (and
      // so unfocusable), focus goes back where it was, or stays by the note.
      requestAnimationFrame(() => {
        if (before?.isConnected && !before.closest("[inert]")) before.focus();
        else view?.focus();
        if (!document.activeElement || document.activeElement === document.body) root.focus();
      });
    };
  }, [fullscreen, view]);

  const changeMode = (next: EditorMode) => {
    setMode(next);
    storeMode(next);
  };

  return (
    <div
      ref={rootRef}
      data-view={shownMode}
      data-title-line={titleLineWrite ? titleLineState : undefined}
      data-fullscreen={fullscreen || undefined}
      tabIndex={-1}
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen || undefined}
      aria-label={fullscreen ? "Full screen editor" : undefined}
      className={cn(
        "doqtri-editor flex flex-col outline-none",
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
      {/* Always mounted, so a notice appearing in it is announced. */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="heading-notice-status">
        {notice ? announcement(notice) : ""}
      </div>
    </div>
  );
}

function announcement(notice: HeadingNotice): string {
  const { message, hint } = headingNoticeText(notice);
  return hint ? `${message} ${hint}` : message;
}
