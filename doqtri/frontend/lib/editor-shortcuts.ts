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

/** What a keydown carries that shortcuts are matched on. */
export type KeyEventLike = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?: (key: string) => boolean;
};

const CODES: Record<string, string> = { "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash" };

/** The physical key (`KeyboardEvent.code`) a shortcut's key sits on in the US layout. */
export function codeFor(key: string): string | undefined {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  return CODES[key];
}

/**
 * Whether a keydown is `shortcut`, with exactly its modifiers.
 *
 * Digits match the key's place (`Digit1`…), not the character: Shift+7 is
 * `/` on a German keyboard and ⌥5 is `[` on a German Mac, and neither
 * should become some other command. Letters and brackets match the
 * character, as the layout labels them, falling back to the place when the
 * layout gives something else (⌥ on a Mac, a Cyrillic layout). AltGr is
 * Ctrl+Alt to the browser on Windows, and the characters it types (`{` is
 * AltGr+7 in German) are never taken for shortcuts.
 */
export function matchesShortcut(shortcut: Shortcut, event: KeyEventLike, mac: boolean): boolean {
  if (event.getModifierState?.("AltGraph")) return false;
  const keys = keysFor(shortcut, mac);
  const meta = !!keys.mod && mac;
  const ctrl = !!keys.ctrl || (!!keys.mod && !mac);
  if (event.metaKey !== meta || event.ctrlKey !== ctrl || event.altKey !== !!keys.alt || event.shiftKey !== !!keys.shift) {
    return false;
  }
  if (/^\d$/.test(keys.key)) return event.code === `Digit${keys.key}`;
  const produced = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (produced === keys.key) return true;
  return !/^[\x20-\x7e]$/.test(event.key) && event.code === codeFor(keys.key);
}

/** The first shortcut in `table` (and its aliases) a keydown is, by name. */
export function resolveShortcut<Id extends string>(
  table: Record<Id, Shortcut>,
  aliases: Partial<Record<Id, Shortcut[]>>,
  event: KeyEventLike,
  mac: boolean,
): Id | null {
  for (const id of Object.keys(table) as Id[]) {
    if ([table[id], ...(aliases[id] ?? [])].some((shortcut) => matchesShortcut(shortcut, event, mac))) return id;
  }
  return null;
}

/** The keydown a shortcut is, on a US layout: for tests, and nothing else. */
export function eventFor(shortcut: Shortcut, mac: boolean): KeyEventLike {
  const keys = keysFor(shortcut, mac);
  return {
    key: keys.shift && /^[a-z]$/.test(keys.key) ? keys.key.toUpperCase() : keys.key,
    code: codeFor(keys.key) ?? keys.key,
    metaKey: !!keys.mod && mac,
    ctrlKey: !!keys.ctrl || (!!keys.mod && !mac),
    altKey: !!keys.alt,
    shiftKey: !!keys.shift,
  };
}
