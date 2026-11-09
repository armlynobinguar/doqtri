import { describe, expect, it } from "vitest";
import { vaultShortcut } from "@/lib/vault-shortcuts";

/** A stand-in element: inside the note editor or not. */
const element = (inEditor: boolean) =>
  ({ closest: (selector: string) => (inEditor && selector === ".cm-editor" ? {} : null) }) as unknown as EventTarget;

const key = (k: string, mods: { meta?: boolean; ctrl?: boolean }, defaultPrevented: boolean, inEditor: boolean) => ({
  key: k,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  defaultPrevented,
  target: element(inEditor),
});

describe("vaultShortcut", () => {
  it("maps ⌘/Ctrl K and N anywhere", () => {
    expect(vaultShortcut(key("k", { meta: true }, false, false))).toBe("switcher");
    expect(vaultShortcut(key("n", { ctrl: true }, false, false))).toBe("new-note");
    expect(vaultShortcut(key("n", { meta: true }, false, true))).toBe("new-note");
    expect(vaultShortcut(key("x", { meta: true }, false, false))).toBeNull();
    expect(vaultShortcut(key("n", {}, false, false))).toBeNull();
  });

  it("leaves a key the note editor handled to the editor (mac Ctrl-N/Ctrl-K)", () => {
    expect(vaultShortcut(key("n", { ctrl: true }, true, true))).toBeNull();
    expect(vaultShortcut(key("k", { ctrl: true }, true, true))).toBeNull();
  });

  it("still toggles when something else handled the key, like the switcher's own list", () => {
    expect(vaultShortcut(key("k", { ctrl: true }, true, false))).toBe("switcher");
    expect(vaultShortcut({ key: "k", metaKey: false, ctrlKey: true, defaultPrevented: true, target: null })).toBe("switcher");
  });
});
