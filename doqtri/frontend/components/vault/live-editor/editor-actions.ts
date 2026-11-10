import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { defaultKeymap, redo, toggleBlockComment, toggleComment, undo } from "@codemirror/commands";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { startCompletion } from "@codemirror/autocomplete";
import {
  clearFormatting,
  indentList,
  insertLink,
  insertWikilink,
  outdentList,
  setParagraphStyle,
  toggleBold,
  toggleBulletList,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleTaskList,
  type FormatCommand,
} from "@/lib/live-preview/commands";
import { isMacPlatform, resolveShortcut, type KeyEventLike, type Shortcut } from "@/lib/editor-shortcuts";

/**
 * The note editor's commands as the toolbar and the keyboard run them, on a
 * view. The edits themselves are lib/live-preview/commands.ts's.
 */

/** Runs a formatting command, unless the note cannot be edited right now. */
export function runFormat(view: EditorView, command: FormatCommand): boolean {
  if (view.state.readOnly) return false;
  view.dispatch(command(view.state));
  return true;
}

/** `[[ ]]` at the caret, with the note list open on it. */
export function insertWikilinkAndSuggest(view: EditorView): boolean {
  if (!runFormat(view, insertWikilink)) return false;
  startCompletion(view);
  return true;
}

export function openFind(view: EditorView): boolean {
  return openSearchPanel(view);
}

/** The search panel, with the replace field focused (just find when read-only). */
export function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]");
  if (field) {
    field.focus();
    field.select();
  }
  return true;
}

export function runUndo(view: EditorView): boolean {
  return !view.state.readOnly && undo(view);
}

export function runRedo(view: EditorView): boolean {
  return !view.state.readOnly && redo(view);
}


/** The shortcuts the toolbar's tooltips name, by control. */
export const SHORTCUTS = {
  undo: { key: "z", mod: true },
  redo: { mac: { key: "z", mod: true, shift: true }, other: { key: "y", ctrl: true } },
  bold: { key: "b", mod: true },
  italic: { key: "i", mod: true },
  strike: { key: "x", mod: true, shift: true },
  link: { key: "k", mod: true },
  ordered: { key: "7", mod: true, shift: true },
  bullet: { key: "8", mod: true, shift: true },
  task: { key: "9", mod: true, shift: true },
  outdent: { key: "[", mod: true },
  indent: { key: "]", mod: true },
  clear: { key: "\\", mod: true },
  find: { key: "f", mod: true },
  replace: { mac: { key: "f", mod: true, alt: true }, other: { key: "h", mod: true } },
  normal: { key: "0", mod: true, alt: true },
  h1: { key: "1", mod: true, alt: true },
  h2: { key: "2", mod: true, alt: true },
  h3: { key: "3", mod: true, alt: true },
  h4: { key: "4", mod: true, alt: true },
  h5: { key: "5", mod: true, alt: true },
  h6: { key: "6", mod: true, alt: true },
} satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** Other keys for the same command: redo is both ⌘⇧Z and Ctrl+Y everywhere. */
export const SHORTCUT_ALIASES: Partial<Record<ShortcutId, Shortcut[]>> = {
  redo: [
    { key: "z", mod: true, shift: true },
    { key: "y", ctrl: true },
  ],
};

/**
 * What each shortcut does. Keyed by the same names as SHORTCUTS, so a
 * tooltip can never name a key that does something else, or nothing.
 */
export const SHORTCUT_COMMANDS: Record<ShortcutId, (view: EditorView) => boolean> = {
  undo: runUndo,
  redo: runRedo,
  bold: (view) => runFormat(view, toggleBold),
  italic: (view) => runFormat(view, toggleItalic),
  strike: (view) => runFormat(view, toggleStrikethrough),
  link: (view) => runFormat(view, insertLink),
  ordered: (view) => runFormat(view, toggleOrderedList),
  bullet: (view) => runFormat(view, toggleBulletList),
  task: (view) => runFormat(view, toggleTaskList),
  outdent: (view) => runFormat(view, outdentList),
  indent: (view) => runFormat(view, indentList),
  clear: (view) => runFormat(view, clearFormatting),
  find: openFind,
  replace: openReplace,
  normal: (view) => runFormat(view, setParagraphStyle("normal")),
  h1: (view) => runFormat(view, setParagraphStyle("h1")),
  h2: (view) => runFormat(view, setParagraphStyle("h2")),
  h3: (view) => runFormat(view, setParagraphStyle("h3")),
  h4: (view) => runFormat(view, setParagraphStyle("h4")),
  h5: (view) => runFormat(view, setParagraphStyle("h5")),
  h6: (view) => runFormat(view, setParagraphStyle("h6")),
};

/** The shortcut a keydown in the editor is, if any. */
export function shortcutFor(event: KeyEventLike, mac: boolean): ShortcutId | null {
  return resolveShortcut(SHORTCUTS, SHORTCUT_ALIASES, event, mac);
}

/**
 * The toolbar's shortcuts, ahead of CodeMirror's own keys (whose ⌘[ and ⌘]
 * indent any line, where these nest list items), matched as
 * lib/editor-shortcuts.ts describes so another keyboard layout's characters
 * are never taken for them.
 *
 * Every one is handled even while the note is read-only, so the browser's
 * own use of the key (⌘[ goes Back, Ctrl+H opens the history) never fires
 * from the note instead — except ⌘K, which then reaches the vault's quick
 * switcher. None is ⌘N; lib/vault-shortcuts.ts leaves keys the editor
 * handled alone.
 */
export function shortcutKeys(): Extension {
  const mac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform || navigator.userAgent);
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.isComposing) return false;
        const id = shortcutFor(event, mac);
        if (!id) return false;
        if (id === "link" && view.state.readOnly) return false;
        SHORTCUT_COMMANDS[id](view);
        event.preventDefault();
        return true;
      },
    }),
  );
}

/** CodeMirror's default keys, less comment toggling: HTML comments have no place in a note. */
export const editorKeymap: KeyBinding[] = defaultKeymap.filter(
  (binding) => binding.run !== toggleComment && binding.run !== toggleBlockComment,
);

/** Find and replace: CodeMirror's search panel above the text, in the app's words. */
export function findAndReplace(): Extension {
  return [
    search({ top: true }),
    EditorState.phrases.of({
      Find: "Find",
      Replace: "Replace with",
      next: "Next",
      previous: "Previous",
      all: "All",
      "match case": "Match case",
      regexp: "Regex",
      "by word": "Whole word",
      replace: "Replace",
      "replace all": "Replace all",
      close: "Close",
    }),
  ];
}

export { searchKeymap };
