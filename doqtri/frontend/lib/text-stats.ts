import type { SyntaxNode, Tree } from "@lezer/common";

/**
 * The counts the vault's status bar shows for the open note, as Word shows
 * them: words, characters (spaces included) and where the caret is, with the
 * selection's own counts while text is selected.
 *
 * Words and characters are the note's rendered text, not its markdown, so a
 * student checking an essay's length gets the essay's length: heading and
 * list marks, emphasis markers, table pipes, link addresses, image syntax
 * and code fences do not count; link text, alt-free prose and the code
 * inside fences do. Images count as nothing.
 */
export type EditorStats = {
  /** Words and characters of the rendered note. */
  words: number;
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

/** A stretch of syntax: dropped, or (between table cells) read as one space. */
type Hidden = { from: number; to: number; space?: boolean };

/** Marks that start (or end) a line, taken with the spaces around them. */
const LINE_MARKS = new Set(["HeaderMark", "QuoteMark", "ListMark", "TaskMarker"]);
/** Syntax that renders as nothing at all. */
const DROPPED = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "CodeInfo",
  "LinkMark",
  "LinkTitle",
  "LinkLabel",
  "HorizontalRule",
  "WikiLinkMark",
  "Image",
  "HTMLTag",
  "HTMLBlock",
  "Comment",
  "CommentBlock",
  "ProcessingInstruction",
  "ProcessingInstructionBlock",
]);

function children(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === name) out.push(child);
  return out;
}

/** The syntax in `doc` that does not render as text, in order. */
export function hiddenSyntax(tree: Tree, doc: string): Hidden[] {
  const hidden: Hidden[] = [];
  const space = (ch: string | undefined) => ch === " " || ch === "\t";
  tree.iterate({
    enter(ref) {
      const { name, from, to } = ref;
      if (LINE_MARKS.has(name)) {
        let start = from;
        let end = to;
        while (start > 0 && space(doc[start - 1])) start--;
        while (end < doc.length && space(doc[end])) end++;
        hidden.push({ from: start, to: end });
        return false;
      }
      if (DROPPED.has(name)) {
        hidden.push({ from, to });
        return false;
      }
      switch (name) {
        case "Link": {
          const node = ref.node;
          const marks = children(node, "LinkMark");
          // `[text](url "title")`: the text stays, everything from `]` on goes.
          if (marks.length >= 2) {
            hidden.push({ from: marks[0].from, to: marks[0].to }, { from: marks[1].from, to });
            return false;
          }
          return;
        }
        case "WikiLink": {
          const node = ref.node;
          const [open, close] = children(node, "WikiLinkMark");
          const target = node.getChild("WikiLinkTarget");
          if (!open || !close) return false;
          hidden.push({ from: open.from, to: open.to });
          // An aliased link reads as its alias.
          if (target && doc[target.to] === "|") hidden.push({ from: target.from, to: target.to + 1 });
          hidden.push({ from: close.from, to: close.to });
          return false;
        }
        case "Escape":
          hidden.push({ from, to: from + 1 });
          return false;
        case "Table": {
          // Only the cells' text, one space between cells and rows.
          const cells: { from: number; to: number }[] = [];
          ref.node.cursor().iterate((cell) => {
            if (cell.name === "TableCell") cells.push({ from: cell.from, to: cell.to });
          });
          let at = from;
          for (const cell of cells) {
            if (cell.from > at) hidden.push({ from: at, to: cell.from, space: at !== from });
            at = cell.to;
          }
          if (to > at) hidden.push({ from: at, to });
          return false;
        }
      }
    },
  });
  return hidden.sort((a, b) => a.from - b.from);
}

/** The rendered text of `from`–`to`, given the hidden syntax. */
export function renderedText(doc: string, hidden: Hidden[], from = 0, to = doc.length): string {
  let text = "";
  let at = from;
  for (const range of hidden) {
    if (range.to <= at) continue;
    if (range.from >= to) break;
    if (range.from > at) text += doc.slice(at, range.from);
    if (range.space) text += " ";
    at = Math.max(at, Math.min(range.to, to));
  }
  if (to > at) text += doc.slice(at, to);
  return text;
}

/** Words and characters (spaces included, line breaks not) of rendered text. */
export function textCounts(text: string): { words: number; chars: number } {
  return { words: countWords(text), chars: text.replace(/\n/g, "").length };
}
