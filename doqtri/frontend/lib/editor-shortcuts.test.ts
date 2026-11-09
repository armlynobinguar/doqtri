import { describe, expect, it } from "vitest";
import { ariaShortcut, isMacPlatform, shortcutLabel, withShortcut, type Shortcut } from "@/lib/editor-shortcuts";

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
