import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { history, toggleComment } from "@codemirror/commands";
import { search, searchPanelOpen } from "@codemirror/search";
import { eventFor } from "@/lib/editor-shortcuts";
import {
  editorKeymap,
  SHORTCUT_ALIASES,
  SHORTCUT_COMMANDS,
  SHORTCUTS,
  shortcutFor,
  type ShortcutId,
} from "@/components/vault/live-editor/editor-actions";

/*
 * The toolbar's tooltips and aria-keyshortcuts come from SHORTCUTS; the keys
 * the editor answers to come from the same table, through shortcutFor and
 * SHORTCUT_COMMANDS. These pin the two together, on both platforms.
 */
describe("editor shortcuts", () => {
  const ids = Object.keys(SHORTCUTS) as ShortcutId[];

  it("has a command for every shortcut a tooltip names, and no other", () => {
    expect(Object.keys(SHORTCUT_COMMANDS).sort()).toEqual([...ids].sort());
  });

  for (const mac of [true, false]) {
    it(`answers every named shortcut with its own command (${mac ? "Mac" : "elsewhere"})`, () => {
      for (const id of ids) expect(shortcutFor(eventFor(SHORTCUTS[id], mac), mac)).toBe(id);
      for (const [id, aliases] of Object.entries(SHORTCUT_ALIASES)) {
        for (const alias of aliases ?? []) expect(shortcutFor(eventFor(alias, mac), mac)).toBe(id);
      }
    });
  }

  it("keeps each shortcut distinct", () => {
    for (const mac of [true, false]) {
      const seen = new Set(ids.map((id) => JSON.stringify(eventFor(SHORTCUTS[id], mac))));
      expect(seen.size).toBe(ids.length);
    }
  });

  it("takes the layout's characters for nothing: ⌘⇧7 is a numbered list even where it types /", () => {
    const german = { key: "/", code: "Digit7", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
    expect(shortcutFor(german, true)).toBe("ordered");
    expect(editorKeymap.some((binding) => binding.run === toggleComment)).toBe(false);
    expect(editorKeymap.some((binding) => binding.key === "Mod-/")).toBe(false);
  });
});

/** Just enough of a view for the commands: state, dispatch, and a DOM with no panel in it. */
function fakeView(doc: string, anchor: number, head = anchor, extensions: Extension[] = []) {
  const view = {
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [history(), search(), ...extensions],
    }),
    dispatch(spec: Transaction | TransactionSpec) {
      view.state = spec instanceof Transaction ? spec.state : view.state.update(spec).state;
    },
    dom: { querySelector: () => null },
    focus() {},
  };
  return view;
}

/** What each command does to a note: a mixed-up entry in SHORTCUT_COMMANDS fails here. */
const EFFECTS: Record<ShortcutId, { doc: string; at: number; to?: number; expect: (state: EditorState) => unknown; want: unknown }> = {
  undo: { doc: "a", at: 1, expect: (s) => s.doc.toString(), want: "a" },
  redo: { doc: "a", at: 1, expect: (s) => s.doc.toString(), want: "ab" },
  bold: { doc: "word", at: 2, expect: (s) => s.doc.toString(), want: "**word**" },
  italic: { doc: "word", at: 2, expect: (s) => s.doc.toString(), want: "*word*" },
  strike: { doc: "word", at: 2, expect: (s) => s.doc.toString(), want: "~~word~~" },
  link: { doc: "word", at: 2, expect: (s) => s.doc.toString(), want: "[word](url)" },
  ordered: { doc: "item", at: 2, expect: (s) => s.doc.toString(), want: "1. item" },
  bullet: { doc: "item", at: 2, expect: (s) => s.doc.toString(), want: "- item" },
  task: { doc: "item", at: 2, expect: (s) => s.doc.toString(), want: "- [ ] item" },
  outdent: { doc: "- a\n  - b", at: 9, expect: (s) => s.doc.toString(), want: "- a\n- b" },
  indent: { doc: "- a\n- b", at: 7, expect: (s) => s.doc.toString(), want: "- a\n  - b" },
  clear: { doc: "# **word**", at: 5, expect: (s) => s.doc.toString(), want: "word" },
  find: { doc: "word", at: 0, expect: (s) => searchPanelOpen(s), want: true },
  replace: { doc: "word", at: 0, expect: (s) => searchPanelOpen(s), want: true },
  normal: { doc: "## T", at: 4, expect: (s) => s.doc.toString(), want: "T" },
  h1: { doc: "T", at: 1, expect: (s) => s.doc.toString(), want: "# T" },
  h2: { doc: "T", at: 1, expect: (s) => s.doc.toString(), want: "## T" },
  h3: { doc: "T", at: 1, expect: (s) => s.doc.toString(), want: "### T" },
  h4: { doc: "T", at: 1, expect: (s) => s.doc.toString(), want: "#### T" },
  h5: { doc: "T", at: 1, expect: (s) => s.doc.toString(), want: "##### T" },
  h6: { doc: "T", at: 1, expect: (s) => s.doc.toString(), want: "###### T" },
};

describe("each shortcut's command", () => {
  for (const id of Object.keys(EFFECTS) as ShortcutId[]) {
    it(`${id} does what its tooltip says`, () => {
      const effect = EFFECTS[id];
      const view = fakeView(effect.doc, effect.at, effect.to);
      if (id === "undo" || id === "redo") {
        view.dispatch({ changes: { from: 1, insert: "b" } });
        if (id === "redo") SHORTCUT_COMMANDS.undo(view as unknown as EditorView);
      }
      SHORTCUT_COMMANDS[id](view as unknown as EditorView);
      expect(effect.expect(view.state)).toEqual(effect.want);
    });
  }

  it("changes nothing in a read-only note", () => {
    for (const id of Object.keys(EFFECTS) as ShortcutId[]) {
      if (id === "find" || id === "replace") continue;
      const effect = EFFECTS[id];
      const view = fakeView(effect.doc, effect.at, effect.to, [EditorState.readOnly.of(true)]);
      SHORTCUT_COMMANDS[id](view as unknown as EditorView);
      expect(view.state.doc.toString()).toBe(effect.doc);
    }
  });
});
