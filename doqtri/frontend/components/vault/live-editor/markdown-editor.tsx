"use client";

import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import { Annotation, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { BoldIcon, CodeIcon, HeadingIcon, ItalicIcon, LinkIcon, ListIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PREVIEW_MARKDOWN_EXTENSIONS } from "@/lib/live-preview/syntax";
import {
  insertLink,
  toggleBold,
  toggleBulletList,
  toggleCode,
  toggleHeading,
  toggleItalic,
  type FormatCommand,
} from "@/lib/live-preview/commands";
import { livePreview } from "@/components/vault/live-editor/live-preview";
import { editorTheme } from "@/components/vault/live-editor/theme";
import { wikilinkCompletion } from "@/components/vault/live-editor/wikilink-completion";
import { linkFollowing, noteOpener } from "@/components/vault/live-editor/link-following";

/** Marks the transactions that load text from outside, so they are not echoed back. */
const external = Annotation.define<boolean>();

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

const run = (command: FormatCommand) => (view: EditorView) => {
  if (view.state.readOnly) return false;
  view.dispatch(command(view.state));
  return true;
};

/**
 * The note editor: one column of markdown that reads as rendered text, with
 * the raw source shown only on the lines being edited (see live-preview.ts).
 *
 * The document is the markdown string and nothing else — `onChange` receives
 * it whole after every edit, exactly as typed, and a new `value` from outside
 * (a reload, a regenerate) replaces it. There is no rich-text model to drift
 * from what is saved and hashed.
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
  /** Phone layout: finger-sized toolbar. */
  compact?: boolean;
  /** Grow with the text instead of filling and scrolling (the demo's read-only note). */
  autoHeight?: boolean;
  /** Opens the note a followed `[[wikilink]]` names; none, and wikilinks do not open. */
  onOpenNote?: (title: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [lock] = useState(() => new Compartment());

  // Read by CodeMirror callbacks, which outlive a render.
  const onChangeRef = useRef(onChange);
  const titlesRef = useRef(linkTitles);
  const openNoteRef = useRef(onOpenNote);
  /** The text this editor last reported, so its own echo is not re-applied. */
  const reportedRef = useRef(value);
  useEffect(() => {
    onChangeRef.current = onChange;
    titlesRef.current = linkTitles;
    openNoteRef.current = onOpenNote;
  });

  const lockExtensions = (locked: boolean, focusable: boolean) => [
    EditorState.readOnly.of(locked),
    EditorView.editable.of(!locked || focusable),
  ];

  // Built once; later prop changes go through the compartment and the
  // value effect below rather than rebuilding the editor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const created = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: reportedRef.current,
        extensions: [
          lock.of(lockExtensions(readOnly, pending)),
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
          livePreview(),
          linkFollowing(),
          noteOpener.of((title) => openNoteRef.current?.(title)),
          wikilinkCompletion(() => titlesRef.current),
          Prec.high(
            keymap.of([
              { key: "Mod-b", run: run(toggleBold) },
              { key: "Mod-i", run: run(toggleItalic) },
              // Kept from the window, where ⌘K would also open the quick switcher.
              { key: "Mod-k", run: run(insertLink), stopPropagation: true },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({
            "aria-label": "Note text",
            spellcheck: "false",
            autocorrect: "off",
          }),
          editorTheme,
          // Read-only means no edits from anywhere but outside: not a key, a
          // paste, a completion or a checkbox. CodeMirror only blocks typing.
          EditorState.changeFilter.of((tr) => !tr.startState.readOnly || tr.annotation(external) === true),
          EditorView.updateListener.of((update) => {
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
    setView(created);
    return () => {
      created.destroy();
      setView(null);
    };
    // Mount only: see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view?.dispatch({ effects: lock.reconfigure(lockExtensions(readOnly, pending)) });
  }, [view, lock, readOnly, pending]);

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

  return (
    <div className={cn("doqtri-editor flex flex-col", !autoHeight && "h-full min-h-0")}>
      {/* Drawn before the editor exists too, so the text never shifts down under it. */}
      {/* While the lock loads it shows, disabled, so it never pops in and pushes the text down. */}
      {(!readOnly || pending) && <FormatToolbar view={view} compact={compact} disabled={readOnly} />}
      <div ref={hostRef} className={cn(!autoHeight && "min-h-0 flex-1")} data-testid="note-editor" />
    </div>
  );
}

type Tool = {
  label: string;
  shortcut?: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  command: FormatCommand;
};

const TOOLS: Tool[] = [
  { label: "Bold", shortcut: "B", icon: BoldIcon, command: toggleBold },
  { label: "Italic", shortcut: "I", icon: ItalicIcon, command: toggleItalic },
  { label: "Heading", icon: HeadingIcon, command: toggleHeading },
  { label: "Bulleted list", icon: ListIcon, command: toggleBulletList },
  { label: "Link", shortcut: "K", icon: LinkIcon, command: insertLink },
  { label: "Code", icon: CodeIcon, command: toggleCode },
];

/** Bold, italic, heading, list, link and code — the markdown most notes need. */
function FormatToolbar({
  view,
  compact,
  disabled,
}: {
  view: EditorView | null;
  compact: boolean;
  disabled: boolean;
}) {
  const [mac] = useState(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      className={cn(
        "border-border/60 flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2 [scrollbar-width:none]",
        compact ? "h-12" : "h-10 pointer-coarse:h-12",
      )}
    >
      {TOOLS.map(({ label, shortcut, icon: Icon, command }) => {
        const hint = shortcut ? `${label} (${mac ? `⌘${shortcut}` : `Ctrl+${shortcut}`})` : label;
        return (
          <Tooltip key={label}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  aria-keyshortcuts={shortcut ? `${mac ? "Meta" : "Control"}+${shortcut}` : undefined}
                  // Keep the caret (and the selection being formatted) in the editor.
                  onMouseDown={(event) => event.preventDefault()}
                  disabled={!view || disabled}
                  onClick={() => {
                    if (!view || view.state.readOnly) return;
                    view.dispatch(command(view.state));
                    view.focus();
                  }}
                  className={cn(
                    "text-muted-foreground hover:text-foreground focus-visible:ring-ring flex shrink-0 disabled:opacity-50 items-center justify-center rounded-md transition-colors duration-150 hover:bg-[var(--glass-strong)] focus-visible:ring-1 focus-visible:outline-hidden",
                    compact ? "size-11" : "size-7 pointer-coarse:size-11",
                  )}
                />
              }
            >
              <Icon className={compact ? "size-[18px]" : "size-3.5"} strokeWidth={1.75} />
            </TooltipTrigger>
            <TooltipContent side="bottom">{hint}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
