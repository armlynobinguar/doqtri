import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
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
  type ParagraphStyle,
} from "@/lib/live-preview/commands";
import type { Shortcut } from "@/lib/editor-shortcuts";

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

/**
 * For keys the browser has a use of its own for (⌘[ goes Back, Ctrl+H opens
 * the history): handled even while read-only, so that never fires from the
 * note instead.
 */
const always = (command: FormatCommand) => (view: EditorView) => {
  runFormat(view, command);
  return true;
};

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

const STYLE_KEYS: [string, ParagraphStyle][] = [
  ["0", "normal"],
  ["1", "h1"],
  ["2", "h2"],
  ["3", "h3"],
  ["4", "h4"],
  ["5", "h5"],
  ["6", "h6"],
];

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
  ...Object.fromEntries(STYLE_KEYS.map(([key, style]) => [style, { key, mod: true, alt: true }])),
} satisfies Record<string, Shortcut>;

/**
 * The formatting keys, ahead of CodeMirror's defaults (whose ⌘[ and ⌘]
 * indent any line, where these nest list items). None of them is ⌘N, and
 * ⌘K is kept from the window, where it would also open the quick switcher;
 * lib/vault-shortcuts.ts leaves keys the editor handled alone.
 */
export const formattingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: always(toggleBold) },
  { key: "Mod-i", run: always(toggleItalic) },
  { key: "Mod-k", run: (view) => runFormat(view, insertLink), stopPropagation: true },
  { key: "Mod-Shift-x", run: always(toggleStrikethrough) },
  ...STYLE_KEYS.map(([key, style]): KeyBinding => ({ key: `Mod-Alt-${key}`, run: always(setParagraphStyle(style)) })),
  { key: "Mod-Shift-7", run: always(toggleOrderedList) },
  { key: "Mod-Shift-8", run: always(toggleBulletList) },
  { key: "Mod-Shift-9", run: always(toggleTaskList) },
  { key: "Mod-]", run: always(indentList) },
  { key: "Mod-[", run: always(outdentList) },
  { key: "Mod-\\", run: always(clearFormatting) },
  // Undo is the history keymap's Mod-z; redo answers both of the usual keys.
  { key: "Mod-Shift-z", run: redo, preventDefault: true },
  { key: "Ctrl-y", run: redo, preventDefault: true },
  // ⌘H hides the app on a Mac, so replace is ⌥⌘F there.
  { key: "Mod-h", mac: "Mod-Alt-f", run: openReplace, preventDefault: true },
];

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
