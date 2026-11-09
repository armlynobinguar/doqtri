/**
 * Keyboard shortcuts as the note editor's toolbar names them: ⌘ on the Mac,
 * Ctrl everywhere else, in each platform's own spelling — `⌥⌘1` on a Mac,
 * `Ctrl+Alt+1` elsewhere — and in the form `aria-keyshortcuts` wants.
 *
 * `mod` is ⌘ or Ctrl by platform; `ctrl` is the Control key itself, which
 * only redo's Ctrl+Y uses.
 */
export type Keys = { key: string; mod?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean };

/** One shortcut everywhere, or a different one on the Mac. */
export type Shortcut = Keys | { mac: Keys; other: Keys };

export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad/.test(platform);
}

function keysFor(shortcut: Shortcut, mac: boolean): Keys {
  return "mac" in shortcut ? (mac ? shortcut.mac : shortcut.other) : shortcut;
}

const keyName = (key: string) => (key.length === 1 ? key.toUpperCase() : key);

/** `⇧⌘X` on a Mac (Apple's modifier order: ⌃⌥⇧⌘), `Ctrl+Shift+X` elsewhere. */
export function shortcutLabel(shortcut: Shortcut, mac: boolean): string {
  const keys = keysFor(shortcut, mac);
  if (mac) {
    return `${keys.ctrl ? "⌃" : ""}${keys.alt ? "⌥" : ""}${keys.shift ? "⇧" : ""}${keys.mod ? "⌘" : ""}${keyName(keys.key)}`;
  }
  return [keys.mod || keys.ctrl ? "Ctrl" : "", keys.alt ? "Alt" : "", keys.shift ? "Shift" : "", keyName(keys.key)]
    .filter(Boolean)
    .join("+");
}

/** The same shortcut for `aria-keyshortcuts`: `Meta+Shift+X`, `Control+Alt+1`. */
export function ariaShortcut(shortcut: Shortcut, mac: boolean): string {
  const keys = keysFor(shortcut, mac);
  return [
    keys.ctrl || (keys.mod && !mac) ? "Control" : "",
    keys.mod && mac ? "Meta" : "",
    keys.alt ? "Alt" : "",
    keys.shift ? "Shift" : "",
    keyName(keys.key),
  ]
    .filter(Boolean)
    .join("+");
}

/** A control's tooltip: its name, and its shortcut when it has one. */
export function withShortcut(label: string, shortcut: Shortcut | undefined, mac: boolean): string {
  return shortcut ? `${label} (${shortcutLabel(shortcut, mac)})` : label;
}
