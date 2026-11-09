import { describe, expect, it } from "vitest";
import {
  ariaShortcut,
  eventFor,
  isMacPlatform,
  matchesShortcut,
  resolveShortcut,
  shortcutLabel,
  withShortcut,
  type KeyEventLike,
  type Shortcut,
} from "@/lib/editor-shortcuts";

const redo: Shortcut = { mac: { key: "z", mod: true, shift: true }, other: { key: "y", ctrl: true } };

describe("editor shortcuts", () => {
  it("spells a shortcut with ⌘ on the Mac and Ctrl elsewhere", () => {
    expect(shortcutLabel({ key: "b", mod: true }, true)).toBe("⌘B");
    expect(shortcutLabel({ key: "b", mod: true }, false)).toBe("Ctrl+B");
    expect(shortcutLabel({ key: "x", mod: true, shift: true }, true)).toBe("⇧⌘X");
    expect(shortcutLabel({ key: "x", mod: true, shift: true }, false)).toBe("Ctrl+Shift+X");
    expect(shortcutLabel({ key: "1", mod: true, alt: true }, true)).toBe("⌥⌘1");
    expect(shortcutLabel({ key: "1", mod: true, alt: true }, false)).toBe("Ctrl+Alt+1");
    expect(shortcutLabel({ key: "\\", mod: true }, false)).toBe("Ctrl+\\");
  });

  it("picks the platform's own shortcut where they differ", () => {
    expect(shortcutLabel(redo, true)).toBe("⇧⌘Z");
    expect(shortcutLabel(redo, false)).toBe("Ctrl+Y");
  });

  it("names the keys for aria-keyshortcuts", () => {
    expect(ariaShortcut({ key: "b", mod: true }, true)).toBe("Meta+B");
    expect(ariaShortcut({ key: "1", mod: true, alt: true }, false)).toBe("Control+Alt+1");
    expect(ariaShortcut(redo, false)).toBe("Control+Y");
  });

  it("puts the shortcut after the label, when there is one", () => {
    expect(withShortcut("Bold", { key: "b", mod: true }, true)).toBe("Bold (⌘B)");
    expect(withShortcut("Table", undefined, true)).toBe("Table");
  });

  it("tells the Mac by its platform string", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPhone")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });
});

describe("matching shortcuts on a keydown", () => {
  const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });
  const h1: Shortcut = { key: "1", mod: true, alt: true };
  const numbered: Shortcut = { key: "7", mod: true, shift: true };
  const bold: Shortcut = { key: "b", mod: true };

  it("needs exactly the shortcut's modifiers, with ⌘ on the Mac and Ctrl elsewhere", () => {
    expect(matchesShortcut(bold, ev({ key: "b", code: "KeyB", metaKey: true }), true)).toBe(true);
    expect(matchesShortcut(bold, ev({ key: "b", code: "KeyB", ctrlKey: true }), true)).toBe(false);
    expect(matchesShortcut(bold, ev({ key: "b", code: "KeyB", ctrlKey: true }), false)).toBe(true);
    expect(matchesShortcut(bold, ev({ key: "B", code: "KeyB", ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it("matches digits by the key's place, whatever character the layout types there", () => {
    // German: Shift+7 is "/", ⌥5 is "[" on a Mac.
    expect(matchesShortcut(numbered, ev({ key: "/", code: "Digit7", metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchesShortcut(numbered, ev({ key: "&", code: "Digit7", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(matchesShortcut({ key: "5", mod: true, alt: true }, ev({ key: "[", code: "Digit5", metaKey: true, altKey: true }), true)).toBe(true);
    expect(matchesShortcut(h1, ev({ key: "1", code: "Numpad1", ctrlKey: true, altKey: true }), false)).toBe(false);
  });

  it("leaves AltGr characters alone on Windows layouts", () => {
    const altGr7 = ev({ key: "{", code: "Digit7", ctrlKey: true, altKey: true, getModifierState: (k) => k === "AltGraph" });
    expect(matchesShortcut({ key: "7", mod: true, alt: true }, altGr7, false)).toBe(false);
    const altGr1 = ev({ key: "1", code: "Digit1", ctrlKey: true, altKey: true, getModifierState: () => false });
    expect(matchesShortcut(h1, altGr1, false)).toBe(true);
  });

  it("falls back to the place when the layout types another letter", () => {
    // ⌥⌘F types "ƒ" on a Mac; a Cyrillic layout types "и" on the B key.
    expect(matchesShortcut({ key: "f", mod: true, alt: true }, ev({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true }), true)).toBe(true);
    expect(matchesShortcut(bold, ev({ key: "и", code: "KeyB", ctrlKey: true }), false)).toBe(true);
    // A Latin layout that puts B elsewhere is matched by its label, not the place.
    expect(matchesShortcut(bold, ev({ key: "x", code: "KeyB", ctrlKey: true }), false)).toBe(false);
  });

  it("resolves a keydown to its shortcut's name, aliases included", () => {
    const table = { bold, h1 } as const;
    const aliases = { bold: [{ key: "g", ctrl: true }] };
    expect(resolveShortcut(table, aliases, eventFor(h1, true), true)).toBe("h1");
    expect(resolveShortcut(table, aliases, ev({ key: "g", code: "KeyG", ctrlKey: true }), true)).toBe("bold");
    expect(resolveShortcut(table, aliases, ev({ key: "q", code: "KeyQ", metaKey: true }), true)).toBeNull();
  });
});
