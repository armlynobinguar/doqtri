/**
 * The vault's global shortcuts: ⌘K/Ctrl-K toggles the quick switcher and
 * ⌘N/Ctrl-N makes a new note, from anywhere in the vault.
 *
 * One exception: a key the note editor has already handled. On the Mac,
 * Ctrl-N and Ctrl-K are the editor's emacs-style caret keys (line down,
 * delete to line end); taking them for the vault too would move the caret
 * and create a note at once. Anything else that handled the key first —
 * the quick switcher's own list keys, say — does not stop the shortcut.
 */
export type VaultShortcut = "switcher" | "new-note";

type KeyEventLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
};

export function vaultShortcut(event: KeyEventLike): VaultShortcut | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  const shortcut = event.key === "k" ? "switcher" : event.key === "n" ? "new-note" : null;
  if (!shortcut) return null;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  if (event.defaultPrevented && target?.closest?.(".cm-editor")) return null;
  return shortcut;
}
