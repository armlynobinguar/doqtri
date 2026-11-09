/**
 * The counts the vault's status bar shows for the open note, as Word shows
 * them: words, characters (spaces included) and where the caret is, with the
 * selection's own counts while text is selected.
 */
export type EditorStats = {
  /** Characters in the note's markdown. */
  chars: number;
  /** The caret's line and column, both from 1. */
  line: number;
  col: number;
  /** The selection's counts, or null for a bare caret. */
  selection: { words: number; chars: number } | null;
};

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
