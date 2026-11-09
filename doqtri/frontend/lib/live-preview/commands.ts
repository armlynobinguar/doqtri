import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";

/**
 * The formatting toolbar's edits, as plain markdown text changes.
 *
 * Each takes an editor state and returns the transaction to apply, so they
 * run (and are tested) without a view. Every one of them only inserts or
 * removes markdown characters — the document stays plain text.
 */

export type FormatCommand = (state: EditorState) => TransactionSpec;

const FORMAT = { userEvent: "input.format", scrollIntoView: true } as const;

/**
 * Wraps each selection in `marker` (bold, italic, inline code), or unwraps it
 * when it already is. An empty selection gets an empty pair with the caret
 * inside, ready to type.
 */
export function toggleWrap(marker: string): FormatCommand {
  const size = marker.length;
  return (state) => ({
    ...FORMAT,
    ...state.changeByRange((range) => {
      const { from, to } = range;
      const text = state.sliceDoc(from, to);
      if (range.empty) {
        // Inside an empty pair: take it back out.
        if (state.sliceDoc(from - size, from) === marker && state.sliceDoc(to, to + size) === marker) {
          return {
            changes: { from: from - size, to: to + size, insert: "" },
            range: EditorSelection.cursor(from - size),
          };
        }
        return {
          changes: { from, insert: marker + marker },
          range: EditorSelection.cursor(from + size),
        };
      }
      if (text.length >= size * 2 && text.startsWith(marker) && text.endsWith(marker)) {
        return {
          changes: { from, to, insert: text.slice(size, -size) },
          range: EditorSelection.range(from, to - size * 2),
        };
      }
      if (state.sliceDoc(from - size, from) === marker && state.sliceDoc(to, to + size) === marker) {
        return {
          changes: [
            { from: from - size, to: from, insert: "" },
            { from: to, to: to + size, insert: "" },
          ],
          range: EditorSelection.range(from - size, to - size),
        };
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + size, to + size),
      };
    }),
  });
}

export const toggleBold = toggleWrap("**");
export const toggleItalic = toggleWrap("_");

/**
 * Inline code, or a fenced block when the selection spans lines: backticks
 * around a multi-line selection would not make it code.
 */
export const toggleCode: FormatCommand = (state) => {
  const main = state.selection.main;
  const first = state.doc.lineAt(main.from);
  const last = state.doc.lineAt(main.to);
  if (first.number === last.number) return toggleWrap("`")(state);
  return {
    ...FORMAT,
    changes: [
      { from: first.from, insert: "```\n" },
      { from: last.to, insert: "\n```" },
    ],
    selection: EditorSelection.range(first.from + 4, last.to + 4),
  };
};

/** The lines a selection covers, each once, in order. */
function selectedLines(state: EditorState) {
  const seen = new Set<number>();
  const lines = [];
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  return lines;
}

/**
 * Toggles a line prefix on every selected line: removed when all of them
 * have it, added to those without it otherwise. Blank lines in a multi-line
 * selection are left alone.
 */
function toggleLinePrefix(pattern: RegExp, prefix: string): FormatCommand {
  return (state) => {
    const all = selectedLines(state);
    const lines = all.length > 1 ? all.filter((line) => line.text.trim().length > 0) : all;
    const allHave = lines.length > 0 && lines.every((line) => pattern.test(line.text));
    const changes = lines.flatMap((line) => {
      const match = pattern.exec(line.text);
      if (allHave && match) return [{ from: line.from, to: line.from + match[0].length, insert: "" }];
      if (!allHave && !match) return [{ from: line.from, insert: prefix }];
      return [];
    });
    return { ...FORMAT, changes };
  };
}

/** A level-two heading — the level a note's sections use. */
export const toggleHeading = toggleLinePrefix(/^#{1,6}[ \t]+/, "## ");

export const toggleBulletList = toggleLinePrefix(/^[ \t]*[-*+][ \t]+/, "- ");

const URL_LIKE = /^(https?:\/\/|www\.)\S+$/i;

/**
 * A markdown link around the selection, with the part still to fill in
 * selected: the URL for selected text, the text for a selected URL, and the
 * text for an empty selection.
 */
export const insertLink: FormatCommand = (state) => ({
  ...FORMAT,
  ...state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (range.empty) {
      return {
        changes: { from: range.from, insert: "[](url)" },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    if (URL_LIKE.test(text)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const urlAt = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](url)` },
      range: EditorSelection.range(urlAt, urlAt + 3),
    };
  }),
});
