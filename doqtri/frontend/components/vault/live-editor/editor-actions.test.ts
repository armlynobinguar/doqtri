import { describe, expect, it } from "vitest";
import { toggleComment } from "@codemirror/commands";
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
