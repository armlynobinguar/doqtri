import type { Text } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { loadableImageUrl } from "@/lib/live-preview/image";

/**
 * The live-preview rules: which markdown syntax the editor hides, which ranges
 * it styles, and which it swaps for a rendered widget — for a given caret.
 *
 * The rule is Obsidian's: every line reads as rendered text except the lines
 * the caret or selection touches, which show their raw source so they can be
 * edited character for character. A table counts as one unit — touching any
 * of its lines shows the whole table raw.
 *
 * Pure: a parse tree, the document text and the revealed lines in, a list of
 * specs out. The editor (components/vault/live-editor) turns the specs into
 * CodeMirror decorations; the tests here read them directly.
 *
 * Line heights never depend on the caret: a heading line is sized whether it
 * is raw or rendered, so moving the caret only shows and hides the syntax
 * characters themselves.
 */

export type DocRange = { from: number; to: number };

export type PreviewWidget =
  | { type: "bullet" }
  | { type: "hr" }
  | { type: "fence"; lang: string }
  | { type: "task"; checked: boolean }
  | { type: "image"; url: string; alt: string; title: string };

export type PreviewSpec =
  /** Remove the range from view; the text stays in the document. */
  | { kind: "hide"; from: number; to: number }
  /** Style the range with a class. */
  | { kind: "mark"; from: number; to: number; cls: string }
  /** Style the whole line starting at `at`. */
  | { kind: "line"; at: number; cls: string }
  /** Draw a widget in place of the range. */
  | { kind: "widget"; from: number; to: number; widget: PreviewWidget };

/** A selection range touches a block when it overlaps it or sits at either edge. */
export function touches(range: DocRange, block: DocRange): boolean {
  return range.from <= block.to && range.to >= block.from;
}

/** Full-line ranges of the tables the editor draws as a grid. */
export function tableBlocks(tree: Tree, doc: Text, from = 0, to = doc.length): DocRange[] {
  const blocks: DocRange[] = [];
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name === "Table") {
        // Only top-level tables: one inside a list item or a quote shares its
        // lines with the list marker or `>`, which a block widget would eat.
        if (node.node.parent?.name === "Document") {
          blocks.push({ from: doc.lineAt(node.from).from, to: doc.lineAt(node.to).to });
        }
        return false;
      }
      // Inline content never holds a table.
      if (node.name !== "Document" && !BLOCK_CONTAINERS.has(node.name)) return false;
    },
  });
  return blocks;
}

const BLOCK_CONTAINERS = new Set(["Blockquote", "BulletList", "OrderedList", "ListItem"]);

/**
 * The line numbers that show raw source: every line a selection range
 * touches, and every line of a table any range touches.
 *
 * The caller passes no ranges while the editor is unfocused or read-only, so
 * a note reads fully rendered until someone puts a caret in it.
 */
export function revealedLines(
  doc: Text,
  selection: readonly DocRange[],
  tables: readonly DocRange[] = [],
): Set<number> {
  const lines = new Set<number>();
  const addLines = (from: number, to: number) => {
    const last = doc.lineAt(to).number;
    for (let n = doc.lineAt(from).number; n <= last; n++) lines.add(n);
  };
  for (const range of selection) {
    addLines(range.from, range.to);
    for (const table of tables) if (touches(range, table)) addLines(table.from, table.to);
  }
  return lines;
}

const HEADING = /^ATXHeading([1-6])$/;
const SETEXT = /^SetextHeading([12])$/;

const INLINE_STYLES: Record<string, { cls: string; mark: string }> = {
  Emphasis: { cls: "cm-lp-em", mark: "EmphasisMark" },
  StrongEmphasis: { cls: "cm-lp-strong", mark: "EmphasisMark" },
  Strikethrough: { cls: "cm-lp-strike", mark: "StrikethroughMark" },
  InlineCode: { cls: "cm-lp-code", mark: "CodeMark" },
};

/** Muted styling for syntax characters on a revealed line. */
export const SYNTAX_CLASS = "cm-lp-syntax";

function children(node: SyntaxNode, name?: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!name || child.name === name) out.push(child);
  }
  return out;
}

/**
 * Decoration specs for the parts of the document in `ranges` (the editor's
 * visible ranges), given the lines that show raw source.
 *
 * `renderedTables` is false when nothing draws tables as a grid; their source
 * is then always shown, styled as source.
 */
export function previewSpecs(
  tree: Tree,
  doc: Text,
  revealed: ReadonlySet<number>,
  ranges: readonly DocRange[] = [{ from: 0, to: doc.length }],
  renderedTables = true,
): PreviewSpec[] {
  const specs: PreviewSpec[] = [];
  if (ranges.length === 0) return specs;

  const lineOf = (pos: number) => doc.lineAt(pos).number;
  const isRevealed = (pos: number) => revealed.has(lineOf(pos));
  const anyRevealed = (from: number, to: number) => {
    const last = lineOf(to);
    for (let n = lineOf(from); n <= last; n++) if (revealed.has(n)) return true;
    return false;
  };
  const char = (pos: number) => doc.sliceString(pos, pos + 1);

  const hide = (from: number, to: number) => {
    if (to > from) specs.push({ kind: "hide", from, to });
  };
  const mark = (from: number, to: number, cls: string) => {
    if (to > from) specs.push({ kind: "mark", from, to, cls });
  };
  const lineClass = (pos: number, cls: string) => {
    specs.push({ kind: "line", at: doc.lineAt(pos).from, cls });
  };
  const eachLine = (from: number, to: number, fn: (lineFrom: number, index: number, last: boolean) => void) => {
    const first = lineOf(from);
    const last = lineOf(to);
    for (let n = first; n <= last; n++) fn(doc.line(n).from, n - first, n === last);
  };
  /** Hides a syntax mark on a rendered line, or mutes it on a revealed one. */
  const syntax = (from: number, to: number, hidden: boolean) => {
    if (hidden) hide(from, to);
    else mark(from, to, SYNTAX_CLASS);
  };

  const enter = (ref: SyntaxNodeRef): boolean | void => {
    const { name, from, to } = ref;
    const node = ref.node;

    const heading = HEADING.exec(name);
    if (heading) {
      lineClass(from, `cm-lp-h${heading[1]}`);
      const hidden = !isRevealed(from);
      for (const headerMark of children(node, "HeaderMark")) {
        if (headerMark.from === from) {
          // The opening hashes and the space after them.
          let end = headerMark.to;
          while (end < to && /[ \t]/.test(char(end))) end++;
          syntax(headerMark.from, end, hidden);
        } else {
          // Optional closing hashes, with the space before them.
          let start = headerMark.from;
          while (start > from && /[ \t]/.test(char(start - 1))) start--;
          syntax(start, headerMark.to, hidden);
        }
      }
      return;
    }

    const setext = SETEXT.exec(name);
    if (setext) {
      const underline = children(node, "HeaderMark")[0];
      eachLine(from, underline ? underline.from - 1 : to, (lineFrom) =>
        specs.push({ kind: "line", at: lineFrom, cls: `cm-lp-h${setext[1]}` }),
      );
      if (underline) mark(underline.from, underline.to, SYNTAX_CLASS);
      return;
    }

    const inline = INLINE_STYLES[name];
    if (inline) {
      mark(from, to, inline.cls);
      for (const m of children(node, inline.mark)) syntax(m.from, m.to, !isRevealed(m.from));
      // Code spans hold no further markup.
      return name === "InlineCode" ? false : undefined;
    }

    switch (name) {
      case "Link": {
        const marks = children(node, "LinkMark");
        // Only an inline link renders: the parser reads any `[text]` as a
        // reference link, and with no definitions to resolve, bracketed prose
        // would lose its brackets.
        if (marks.length < 2 || children(node, "URL").length === 0) return;
        const [open, close] = marks;
        mark(open.to, close.from, "cm-lp-link");
        const hidden = !anyRevealed(from, to);
        syntax(open.from, open.to, hidden);
        syntax(close.from, to, hidden);
        return;
      }

      case "Image": {
        const marks = children(node, "LinkMark");
        const urlNode = children(node, "URL")[0];
        const url = urlNode ? loadableImageUrl(doc.sliceString(urlNode.from, urlNode.to)) : null;
        if (url && marks.length >= 2 && !anyRevealed(from, to)) {
          const titleNode = children(node, "LinkTitle")[0];
          specs.push({
            kind: "widget",
            from,
            to,
            widget: {
              type: "image",
              url,
              alt: doc.sliceString(marks[0].to, marks[1].from),
              title: titleNode ? doc.sliceString(titleNode.from + 1, titleNode.to - 1) : "",
            },
          });
        } else {
          // Revealed, or an address that is never loaded: source, muted.
          mark(from, to, "cm-lp-image-src");
        }
        return false;
      }

      case "Autolink": {
        const hidden = !isRevealed(from);
        for (const m of children(node, "LinkMark")) syntax(m.from, m.to, hidden);
        const url = children(node, "URL")[0];
        if (url) mark(url.from, url.to, "cm-lp-link");
        return false;
      }

      case "URL": {
        // A bare URL; inside a link or image the URL is syntax, handled above.
        const parent = node.parent?.name;
        if (parent !== "Link" && parent !== "Image" && parent !== "Autolink") {
          mark(from, to, "cm-lp-link");
        }
        return;
      }

      case "WikiLink": {
        const [open, close] = children(node, "WikiLinkMark");
        if (!open || !close) return false;
        const hidden = !isRevealed(from);
        const target = children(node, "WikiLinkTarget")[0];
        const aliased = target && target.to < close.from && char(target.to) === "|";
        // With an alias, the rendered link reads as the alias.
        const textFrom = aliased && hidden ? target.to + 1 : open.to;
        mark(textFrom, close.from, "cm-lp-wikilink");
        syntax(open.from, open.to, hidden);
        if (aliased && hidden) hide(target.from, target.to + 1);
        syntax(close.from, close.to, hidden);
        return false;
      }

      case "ListMark": {
        const list = node.parent?.parent?.name;
        const task = node.parent?.getChild("Task");
        if (list === "OrderedList") {
          mark(from, to, "cm-lp-list-number");
        } else if (isRevealed(from)) {
          mark(from, to, SYNTAX_CLASS);
        } else if (task) {
          // A task's checkbox stands in for its bullet.
          hide(from, task.from);
        } else {
          specs.push({ kind: "widget", from, to, widget: { type: "bullet" } });
        }
        return;
      }

      case "TaskMarker": {
        if (isRevealed(from)) {
          mark(from, to, SYNTAX_CLASS);
        } else {
          const checked = /x/i.test(doc.sliceString(from + 1, to - 1));
          specs.push({ kind: "widget", from, to, widget: { type: "task", checked } });
        }
        return;
      }

      case "Blockquote": {
        // Nested quotes share the outer one's lines; one border is enough.
        if (node.parent?.name !== "Blockquote") eachLine(from, to, (at) => lineClass(at, "cm-lp-quote"));
        return;
      }

      case "QuoteMark": {
        const end = char(to) === " " ? to + 1 : to;
        syntax(from, end, !isRevealed(from));
        return;
      }

      case "HorizontalRule": {
        if (isRevealed(from)) {
          mark(from, to, SYNTAX_CLASS);
        } else {
          lineClass(from, "cm-lp-hr-line");
          specs.push({ kind: "widget", from, to, widget: { type: "hr" } });
        }
        return false;
      }

      case "FencedCode": {
        eachLine(from, to, (at, index, last) => {
          const edges = `${index === 0 ? " cm-lp-fence-first" : ""}${last ? " cm-lp-fence-last" : ""}`;
          specs.push({ kind: "line", at, cls: `cm-lp-fence${edges}` });
        });
        const marks = children(node, "CodeMark");
        const info = children(node, "CodeInfo")[0];
        const open = marks[0];
        if (open) {
          const openEnd = info ? info.to : open.to;
          if (isRevealed(open.from)) {
            mark(open.from, openEnd, SYNTAX_CLASS);
          } else {
            specs.push({
              kind: "widget",
              from: open.from,
              to: openEnd,
              widget: { type: "fence", lang: info ? doc.sliceString(info.from, info.to) : "" },
            });
          }
        }
        const close = marks.length > 1 ? marks[marks.length - 1] : null;
        if (close && lineOf(close.from) !== lineOf(from)) syntax(close.from, close.to, !isRevealed(close.from));
        return false;
      }

      case "CodeBlock": {
        eachLine(from, to, (at) => lineClass(at, "cm-lp-codeblock"));
        return false;
      }

      case "Table": {
        const topLevel = node.parent?.name === "Document";
        const drawn = renderedTables && topLevel && !anyRevealed(doc.lineAt(from).from, doc.lineAt(to).to);
        // A drawn table is replaced whole by its grid (see the table field);
        // otherwise its source shows, in the code face so the pipes line up.
        if (!drawn) eachLine(from, to, (at) => lineClass(at, "cm-lp-table-src"));
        return false;
      }

      case "Escape": {
        syntax(from, from + 1, !isRevealed(from));
        return;
      }
    }
  };

  const start = ranges[0].from;
  const end = ranges[ranges.length - 1].to;
  tree.iterate({ from: start, to: end, enter });
  return specs;
}
