import { ChangeSet, EditorSelection, type EditorState, type Line, type TransactionSpec } from "@codemirror/state";
import { ensureSyntaxTree, language, syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import { previewParser } from "@/lib/live-preview/syntax";
import { loadableImageUrl } from "@/lib/live-preview/image";

/**
 * The formatting toolbar's edits, as plain markdown text changes.
 *
 * Each takes an editor state and returns the transaction to apply, so they
 * run (and are tested) without a view. Every one of them only inserts or
 * removes markdown characters — the document stays plain text, and what is
 * saved is exactly what these produce.
 *
 * They behave the way Word and Google Docs do wherever markdown can say the
 * same thing: a bare caret in a word formats that word, a second press takes
 * the formatting off again, and a paragraph style replaces the one before.
 */

export type FormatCommand = (state: EditorState) => TransactionSpec;

/** One text change, in the start document's positions. */
type Edit = { from: number; to?: number; insert?: string };

const FORMAT = { userEvent: "input.format", scrollIntoView: true } as const;

// ------------------------------------------------------------------ the tree

/**
 * The note's parse tree: the editor's own when the state has the markdown
 * language (finished, if that is quick), or a fresh parse in the same
 * dialect when it has none (the unit tests).
 */
export function markdownTree(state: EditorState): Tree {
  if (state.facet(language)) return ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  return previewParser.parse(state.doc.toString());
}

/** The innermost node at `pos` (on `side`), or one of its ancestors, that passes `test`. */
function ancestor(tree: Tree, pos: number, side: -1 | 1, test: (node: SyntaxNode) => boolean): SyntaxNode | null {
  for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
    if (test(node)) return node;
  }
  return null;
}

/**
 * The `name` node holding `from`–`to`: all of it for a selection, and
 * strictly inside it for a caret — a caret just before `**bold**` or just
 * after it is not in it.
 */
function enclosing(tree: Tree, from: number, to: number, name: string): SyntaxNode | null {
  if (from === to) return ancestor(tree, from, 1, (n) => n.name === name && n.from < from && from < n.to);
  return ancestor(tree, from, 1, (n) => n.name === name && n.from <= from && to <= n.to);
}

function children(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === name) out.push(child);
  return out;
}

// ------------------------------------------------------------- line anatomy

/**
 * What can start a line, in the order markdown allows it: quote markers,
 * indentation, a list marker and its task box, then heading hashes.
 */
const LINE_START =
  /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*)(?:([-*+]|\d{1,9}[.)])([ \t]+|$)(?:(\[[ xX]\])([ \t]+|$))?)?(?:(#{1,6})([ \t]+|$))?/;

export type LineStart = {
  /** `> `, `> > `, or "". */
  quote: string;
  indent: string;
  /** `-`, `*`, `+`, `1.` or `1)`; "" when the line is no list item. */
  marker: string;
  markerSpace: string;
  /** `[ ]` or `[x]`; "" when the item is no task. */
  task: string;
  taskSpace: string;
  /** A heading's hashes; "" for none. */
  hashes: string;
  hashSpace: string;
  /** Where the line's text proper starts. */
  content: number;
};

export function lineStart(text: string): LineStart {
  const m = LINE_START.exec(text)!;
  return {
    quote: m[1] ?? "",
    indent: m[2] ?? "",
    marker: m[3] ?? "",
    markerSpace: m[4] ?? "",
    task: m[5] ?? "",
    taskSpace: m[6] ?? "",
    hashes: m[7] ?? "",
    hashSpace: m[8] ?? "",
    content: m[0].length,
  };
}

const isOrdered = (marker: string) => /^\d/.test(marker);
/** Where a line's list part starts: after its quote markers and indentation. */
const listAt = (start: LineStart) => start.quote.length + start.indent.length;
/** Where its list part ends: after the marker, its space and the task box. */
const listEnd = (start: LineStart) =>
  listAt(start) + start.marker.length + start.markerSpace.length + start.task.length + start.taskSpace.length;

const blank = (line: Line) => line.text.trim().length === 0;

/** The lines the selection covers, each once, in order. */
function selectedLines(state: EditorState): Line[] {
  const byNumber = new Map<number, Line>();
  for (const range of state.selection.ranges) {
    // A selection that ends at the very start of a line does not take that line.
    const end = range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
    const last = state.doc.lineAt(end).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) byNumber.set(n, state.doc.line(n));
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** The selected lines, leaving out blank ones when there is more than one. */
function textLines(state: EditorState): Line[] {
  const all = selectedLines(state);
  return all.length > 1 ? all.filter((line) => !blank(line)) : all;
}

/** Drops repeated edits (two selection ranges in one node, say), which would overlap. */
function dedupe(edits: Edit[]): Edit[] {
  const seen = new Set<string>();
  return edits.filter((edit) => {
    const key = `${edit.from}:${edit.to ?? edit.from}:${edit.insert ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The edits as a transaction, every selection range mapped through them. */
function withEdits(state: EditorState, edits: Edit[]): TransactionSpec {
  const changes = state.changes(dedupe(edits));
  return { ...FORMAT, changes, selection: state.selection.map(changes, 1) };
}

// ------------------------------------------------------- inline formatting

export type InlineFormat = "bold" | "italic" | "strike" | "code";

const INLINE: Record<InlineFormat, { node: string; mark: string; marker: string }> = {
  bold: { node: "StrongEmphasis", mark: "EmphasisMark", marker: "**" },
  // `*`, not `_`: underscores do not make italics inside a word.
  italic: { node: "Emphasis", mark: "EmphasisMark", marker: "*" },
  strike: { node: "Strikethrough", mark: "StrikethroughMark", marker: "~~" },
  code: { node: "InlineCode", mark: "CodeMark", marker: "`" },
};

const WORD = /[\p{L}\p{N}_]/u;

/** The word a bare caret sits strictly inside; null at a word's edge or in space. */
export function wordAround(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  let end = pos - line.from;
  if (end === 0 || end === text.length || !WORD.test(text[end - 1]) || !WORD.test(text[end])) return null;
  let start = end;
  while (start > 0 && WORD.test(text[start - 1])) start--;
  while (end < text.length && WORD.test(text[end])) end++;
  return { from: line.from + start, to: line.from + end };
}

/** How many `ch` run from `pos` in direction `step` (1 forward, -1 back). */
function runAt(state: EditorState, pos: number, ch: string, step: 1 | -1): number {
  let count = 0;
  for (let at = step === 1 ? pos : pos - 1; at >= 0 && at < state.doc.length; at += step) {
    if (state.sliceDoc(at, at + 1) !== ch) break;
    count++;
  }
  return count;
}

/**
 * The parts of a selection that inline formatting applies to, one per line:
 * without the line's block syntax (quote, list and heading markers) and
 * without space at either end, which would stop `**` from rendering.
 */
function segments(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  const parts: { from: number; to: number }[] = [];
  const last = state.doc.lineAt(to).number;
  for (let n = state.doc.lineAt(from).number; n <= last; n++) {
    const line = state.doc.line(n);
    let start = Math.max(from, line.from + lineStart(line.text).content);
    let end = Math.min(to, line.to);
    while (start < end && /\s/.test(state.sliceDoc(start, start + 1))) start++;
    while (end > start && /\s/.test(state.sliceDoc(end - 1, end))) end--;
    if (end > start) parts.push({ from: start, to: end });
  }
  return parts;
}

/** Deletions that take a formatting node's own markers out, keeping its text. */
function unwrap(node: SyntaxNode, mark: string): Edit[] {
  return children(node, mark).map((m) => ({ from: m.from, to: m.to }));
}

/**
 * Bold, italic, strikethrough or inline code, on or off, for every selection
 * range:
 *
 * - inside that formatting (caret or selection), the markers come off;
 * - a bare caret strictly inside a word wraps that word;
 * - a bare caret anywhere else opens an empty pair to type into, and a
 *   second press with nothing typed takes the pair back out;
 * - a selection wraps each line's part of it, without its block syntax and
 *   outer spaces.
 *
 * Bold and italic share `*`. Where the parse tree cannot tell (a pair still
 * being typed), the run of asterisks does: one (or three) for italic, two
 * (or three) for bold — italic on `**word**` adds a third rather than eating
 * the bold, so the two stay distinguishable.
 */
export function toggleInline(format: InlineFormat): FormatCommand {
  const { node: nodeName, mark, marker } = INLINE[format];
  const size = marker.length;
  const ch = marker[0];
  const carries = (run: number) => run === size || (ch === "*" && run === 3);
  return (state) => {
    const tree = markdownTree(state);
    return {
      ...FORMAT,
      ...state.changeByRange((range) => {
        const apply = (edits: Edit[], caret?: number) => {
          const changes = state.changes(edits);
          return {
            changes,
            range: caret === undefined ? range.map(changes, 1) : EditorSelection.cursor(caret),
          };
        };
        const { from, to } = range;

        if (range.empty) {
          const node = enclosing(tree, from, from, nodeName);
          if (node) return apply(unwrap(node, mark));
          const word = wordAround(state, from);
          if (word) return apply([{ from: word.from, insert: marker }, { from: word.to, insert: marker }], from + size);
          if (carries(runAt(state, from, ch, -1)) && carries(runAt(state, from, ch, 1))) {
            return apply([{ from: from - size, to: from + size }], from - size);
          }
          return apply([{ from, insert: marker + marker }], from + size);
        }

        const parts = segments(state, from, to);
        if (parts.length === 0) return { range };
        const nodes = parts.map((part) => enclosing(tree, part.from, part.to, nodeName));

        if (nodes.every((node) => node !== null)) {
          const seen = new Set<number>();
          return apply(
            nodes.flatMap((node) => {
              if (seen.has(node!.from)) return [];
              seen.add(node!.from);
              return unwrap(node!, mark);
            }),
          );
        }

        // What the tree does not call formatted, the marker runs still may:
        // the selection includes the markers, or they are mid-typing.
        if (parts.length === 1) {
          const part = parts[0];
          const span = part.to - part.from;
          if (
            span > size * 2 &&
            carries(Math.min(runAt(state, part.from, ch, 1), span)) &&
            carries(Math.min(runAt(state, part.to, ch, -1), span))
          ) {
            return apply([
              { from: part.from, to: part.from + size },
              { from: part.to - size, to: part.to },
            ]);
          }
          if (carries(runAt(state, part.from, ch, -1)) && carries(runAt(state, part.to, ch, 1))) {
            return apply([
              { from: part.from - size, to: part.from },
              { from: part.to, to: part.to + size },
            ]);
          }
        }

        const changes = state.changes(
          parts.flatMap((part, i) =>
            nodes[i]
              ? []
              : [
                  { from: part.from, insert: marker },
                  { from: part.to, insert: marker },
                ],
          ),
        );
        // The selection keeps to the text, now inside its markers.
        const start = changes.mapPos(parts[0].from, 1);
        const end = changes.mapPos(parts[parts.length - 1].to, -1);
        return { changes, range: range.anchor <= range.head ? EditorSelection.range(start, end) : EditorSelection.range(end, start) };
      }),
    };
  };
}

export const toggleBold = toggleInline("bold");
export const toggleItalic = toggleInline("italic");
export const toggleStrikethrough = toggleInline("strike");

/**
 * Inline code, or a fenced block when the selection spans lines: backticks
 * around several lines would not make them code.
 */
export const toggleCode: FormatCommand = (state) => {
  const main = state.selection.main;
  if (state.doc.lineAt(main.from).number !== state.doc.lineAt(main.to).number) return toggleCodeBlock(state);
  return toggleInline("code")(state);
};

// ------------------------------------------------------------------ links

const URL_LIKE = /^(https?:\/\/|www\.)\S+$/i;

/**
 * A markdown link, with the part still to fill in selected: the URL for
 * selected text or the word at a bare caret, the text for a selected URL,
 * and the text when there is nothing. Inside a link already, it selects
 * that link's URL to change it.
 */
export const insertLink: FormatCommand = (state) => {
  const tree = markdownTree(state);
  return {
    ...FORMAT,
    ...state.changeByRange((range) => {
      const link = range.empty
        ? enclosing(tree, range.from, range.from, "Link")
        : enclosing(tree, range.from, range.to, "Link");
      const url = link?.getChild("URL");
      if (url) return { range: EditorSelection.range(url.from, url.to) };

      let { from, to } = range;
      if (range.empty) {
        const word = wordAround(state, from);
        if (word) ({ from, to } = word);
      }
      const text = state.sliceDoc(from, to);
      if (from === to) {
        return { changes: { from, insert: "[](url)" }, range: EditorSelection.cursor(from + 1) };
      }
      if (URL_LIKE.test(text)) {
        return { changes: { from, to, insert: `[](${text})` }, range: EditorSelection.cursor(from + 1) };
      }
      const urlAt = from + text.length + 3;
      return {
        changes: { from, to, insert: `[${text}](url)` },
        range: EditorSelection.range(urlAt, urlAt + 3),
      };
    }),
  };
};

/**
 * A `[[wikilink]]` around the selection (or the word at a bare caret), with
 * the caret before the closing brackets, where the note list opens.
 */
export const insertWikilink: FormatCommand = (state) => ({
  ...FORMAT,
  ...state.changeByRange((range) => {
    let { from, to } = range;
    if (range.empty) {
      const word = wordAround(state, from);
      if (word) ({ from, to } = word);
    }
    // A link cannot span lines: only the first line's part goes in.
    to = Math.min(to, state.doc.lineAt(from).to);
    const text = state.sliceDoc(from, to).replace(/[[\]|]/g, "").trim();
    return {
      changes: { from, to, insert: `[[${text}]]` },
      range: EditorSelection.cursor(from + 2 + text.length),
    };
  }),
});

/** Alt text that cannot close the brackets around it. */
function escapeAlt(alt: string) {
  return alt.replace(/\s+/g, " ").trim().replace(/([\\[\]])/g, "\\$1");
}

/**
 * `![alt](url)` in place of the selection — for an address the preview may
 * load (lib/live-preview/image.ts: absolute http and https only). Any other
 * address changes nothing.
 */
export function insertImage(url: string, alt: string): FormatCommand {
  return (state) => {
    const href = loadableImageUrl(url);
    if (!href) return {};
    const destination = /[\s()<>]/.test(href) ? `<${href}>` : href;
    const text = `![${escapeAlt(alt)}](${destination})`;
    const { from, to } = state.selection.main;
    return { ...FORMAT, changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length) };
  };
}

// ------------------------------------------------------------------ blocks

/**
 * Puts `text` on lines of its own after the selection's last line (or in
 * place of it, when that line is blank), with a blank line on either side
 * so it cannot run into the paragraphs around it — `---` right under a line
 * of text would turn that line into a heading. Returns where `text` lands.
 */
function insertBlock(state: EditorState, text: string): { edit: Edit; start: number; end: number } {
  const line = state.doc.lineAt(state.selection.main.to);
  const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const from = blank(line) ? line.from : line.to;
  const lead = blank(line) ? (prev && !blank(prev) ? "\n" : "") : "\n\n";
  const trail = next && blank(next) ? "" : "\n";
  const start = from + lead.length;
  return { edit: { from, to: line.to, insert: lead + text + trail }, start, end: start + text.length };
}

/** A horizontal line as its own block, the caret on the line after it. */
export const insertHorizontalRule: FormatCommand = (state) => {
  const block = insertBlock(state, "---");
  return { ...FORMAT, changes: block.edit, selection: EditorSelection.cursor(block.end + 1) };
};

export const MAX_TABLE_SIZE = 8;

/** A GFM table's source. `rows` counts the header row, which is always there. */
export function tableMarkdown(columns: number, rows: number): string {
  const cols = Math.max(1, Math.min(MAX_TABLE_SIZE, columns));
  const count = Math.max(1, Math.min(MAX_TABLE_SIZE, rows));
  const headers = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const lines = [row(headers), row(headers.map((h) => "-".repeat(h.length)))];
  for (let r = 1; r < count; r++) lines.push(row(headers.map((h) => " ".repeat(h.length))));
  return lines.join("\n");
}

/**
 * A `columns` × `rows` table with a header row, as its own block, the first
 * header selected to type over.
 */
export function insertTable(columns: number, rows: number): FormatCommand {
  return (state) => {
    const block = insertBlock(state, tableMarkdown(columns, rows));
    const first = block.start + 2;
    return { ...FORMAT, changes: block.edit, selection: EditorSelection.range(first, first + "Column 1".length) };
  };
}

// --------------------------------------------------------- paragraph style

export type ParagraphStyle = "normal" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote" | "codeblock";

export const PARAGRAPH_STYLES: { style: ParagraphStyle; label: string }[] = [
  { style: "normal", label: "Normal text" },
  { style: "h1", label: "Heading 1" },
  { style: "h2", label: "Heading 2" },
  { style: "h3", label: "Heading 3" },
  { style: "h4", label: "Heading 4" },
  { style: "h5", label: "Heading 5" },
  { style: "h6", label: "Heading 6" },
  { style: "quote", label: "Quote" },
  { style: "codeblock", label: "Code block" },
];

const CODE_BLOCKS = new Set(["FencedCode", "CodeBlock"]);
const QUOTES = new Set(["Blockquote"]);
const SETEXT = new Set(["SetextHeading1", "SetextHeading2"]);

/** The outermost node of a kind touching any of `lines`, each once. */
function blocksOn(tree: Tree, lines: Line[], names: Set<string>): SyntaxNode[] {
  const found = new Map<number, SyntaxNode>();
  for (const line of lines) {
    for (const [pos, side] of [
      [line.from, 1],
      [line.to, -1],
    ] as const) {
      let hit: SyntaxNode | null = null;
      for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
        if (names.has(node.name)) hit = node;
      }
      if (hit) found.set(hit.from, hit);
    }
  }
  return [...found.values()];
}

/** `lines` plus every line of `nodes`, each once, in order. */
function withLinesOf(state: EditorState, lines: Line[], nodes: SyntaxNode[]): Line[] {
  const byNumber = new Map(lines.map((line) => [line.number, line]));
  for (const node of nodes) {
    const last = state.doc.lineAt(node.to).number;
    for (let n = state.doc.lineAt(node.from).number; n <= last; n++) byNumber.set(n, state.doc.line(n));
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** Deletions that turn a fenced code block back into plain lines. */
function unfence(state: EditorState, node: SyntaxNode): Edit[] {
  if (node.name !== "FencedCode") return [];
  const open = state.doc.lineAt(node.from);
  const close = state.doc.lineAt(node.to);
  // The opening fence line with its line break…
  const edits: Edit[] = [{ from: open.from, to: Math.min(open.to + 1, state.doc.length) }];
  // …and the closing one with the break before it, when the block is closed.
  if (children(node, "CodeMark").length > 1 && close.number > open.number) edits.push({ from: close.from - 1, to: close.to });
  return edits;
}

/**
 * One level of quote markers off these lines. With `whole`, off every line
 * of the quotes they are in: a line left behind would stay quoted lazily.
 */
function unquote(state: EditorState, tree: Tree, lines: Line[], whole: boolean): Edit[] {
  const targets = whole ? withLinesOf(state, lines, blocksOn(tree, lines, QUOTES)) : lines;
  return targets.flatMap((line) => {
    const m = /^[ \t]{0,3}>[ \t]?/.exec(line.text);
    return m ? [{ from: line.from, to: line.from + m[0].length }] : [];
  });
}

/** The `===`/`---` underlines of setext headings on these lines. */
function unsetext(state: EditorState, tree: Tree, lines: Line[]): Edit[] {
  return blocksOn(tree, lines, SETEXT).flatMap((node) => {
    const underline = children(node, "HeaderMark")[0];
    if (!underline) return [];
    const line = state.doc.lineAt(underline.from);
    return [{ from: line.from - 1, to: line.to }];
  });
}

/**
 * Sets the paragraph style of every selected line, as the style menu in
 * Docs does: Normal text, Heading 1–6, Quote or Code block, each replacing
 * whichever the line had. A style a line already has stays as it is. List
 * markers stay: a heading in a list item keeps its bullet.
 */
export function setParagraphStyle(style: ParagraphStyle): FormatCommand {
  return (state) => {
    const tree = markdownTree(state);
    const all = selectedLines(state);
    const fenced = blocksOn(tree, all, CODE_BLOCKS);
    const edits: Edit[] = [];

    if (style === "codeblock") {
      const inside = (line: Line) => fenced.some((node) => node.from <= line.from && line.to <= node.to);
      if (all.every(inside)) return {};
      edits.push(...unquote(state, tree, all, false), ...unsetext(state, tree, all));
      for (const line of all) {
        const start = lineStart(line.text);
        const at = line.from + listEnd(start);
        if (start.hashes) edits.push({ from: at, to: at + start.hashes.length + start.hashSpace.length });
      }
      // In steps, so the selection stays on the text between the fences.
      const strip = state.changes(dedupe(edits));
      const open = ChangeSet.of([{ from: strip.mapPos(all[0].from, -1), insert: "```\n" }], strip.newLength);
      const end = open.mapPos(strip.mapPos(all[all.length - 1].to, 1), 1);
      const close = ChangeSet.of([{ from: end, insert: "\n```" }], open.newLength);
      return {
        ...FORMAT,
        changes: strip.compose(open).compose(close),
        selection: state.selection.map(strip, 1).map(open, 1).map(close, -1),
      };
    }

    const fenceLines = new Set(fenced.flatMap((node) => [state.doc.lineAt(node.from).number, state.doc.lineAt(node.to).number]));
    for (const node of fenced) edits.push(...unfence(state, node));
    if (style === "normal") edits.push(...unquote(state, tree, all, true));
    else if (style !== "quote") edits.push(...unquote(state, tree, all, false));
    edits.push(...unsetext(state, tree, all));

    const level = Number(/^h([1-6])$/.exec(style)?.[1] ?? 0);
    const lines = style === "quote" ? all : textLines(state);
    for (const line of lines) {
      if (fenceLines.has(line.number)) continue;
      const start = lineStart(line.text);
      const at = line.from + listEnd(start);
      const end = at + start.hashes.length + start.hashSpace.length;
      if (level) {
        if (start.hashes.length !== level || !start.hashSpace) edits.push({ from: at, to: end, insert: `${"#".repeat(level)} ` });
      } else if (start.hashes) {
        edits.push({ from: at, to: end });
      }
      if (style === "quote" && !start.quote) edits.push({ from: line.from, insert: blank(line) ? ">" : "> " });
    }
    return withEdits(state, edits);
  };
}

/** A level-two heading — the level a note's sections use — on and off. */
export const toggleHeading: FormatCommand = (state) => {
  const allHave = textLines(state).every((line) => lineStart(line.text).hashes.length > 0);
  return setParagraphStyle(allHave ? "normal" : "h2")(state);
};

/** Quote on, or off for the whole quote the selection is in. */
export const toggleBlockquote: FormatCommand = (state) => {
  const tree = markdownTree(state);
  const quoted = (line: Line) => lineStart(line.text).quote.length > 0 || blocksOn(tree, [line], QUOTES).length > 0;
  if (textLines(state).every(quoted)) return withEdits(state, unquote(state, tree, selectedLines(state), true));
  return setParagraphStyle("quote")(state);
};

/** Code block on (fences around the lines), or off (the fences go). */
export const toggleCodeBlock: FormatCommand = (state) => {
  const tree = markdownTree(state);
  const fenced = blocksOn(tree, selectedLines(state), CODE_BLOCKS);
  if (fenced.length > 0) return withEdits(state, fenced.flatMap((node) => unfence(state, node)));
  return setParagraphStyle("codeblock")(state);
};

// ------------------------------------------------------------------- lists

export type ListKind = "bullet" | "ordered" | "task";

function listKind(start: LineStart): ListKind | null {
  if (!start.marker) return null;
  if (start.task) return "task";
  return isOrdered(start.marker) ? "ordered" : "bullet";
}

/**
 * The nearest list item above `line` whose indentation passes `test`, past
 * blank lines and the indented lines inside items; null once the list ends.
 */
function itemAbove(state: EditorState, line: Line, test: (indent: number) => boolean): LineStart | null {
  for (let n = line.number - 1; n >= 1; n--) {
    const prev = state.doc.line(n);
    if (blank(prev)) continue;
    const start = lineStart(prev.text);
    if (!start.marker) {
      if (/^[ \t]/.test(prev.text)) continue;
      return null;
    }
    if (test(start.indent.length)) return start;
  }
  return null;
}

/** The number for an ordered item at `indent` after the items above it. */
function numberAfter(state: EditorState, line: Line, indent: number, fallback: number): number {
  const prev = itemAbove(state, line, (i) => i <= indent);
  return prev && prev.indent.length === indent && isOrdered(prev.marker) ? parseInt(prev.marker, 10) + 1 : fallback;
}

/**
 * Bulleted list, numbered list or checklist on every selected line: off when
 * every line is that kind already, otherwise on, turning other kinds into
 * this one. Blank lines in a multi-line selection are left alone.
 */
export function toggleList(kind: ListKind): FormatCommand {
  return (state) => {
    const lines = textLines(state);
    const allHave = lines.length > 0 && lines.every((line) => listKind(lineStart(line.text)) === kind);
    const edits: Edit[] = [];
    const counters = new Map<number, number>();
    for (const line of lines) {
      const start = lineStart(line.text);
      const end = line.from + listEnd(start);
      if (allHave) {
        // Off: the marker, and the indentation that nested it.
        edits.push({ from: line.from + start.quote.length, to: end });
        continue;
      }
      if (listKind(start) === kind) continue;
      let marker = kind === "task" ? "- [ ] " : "- ";
      if (kind === "ordered") {
        const indent = start.indent.length;
        const n = counters.get(indent) ?? numberAfter(state, line, indent, 1);
        counters.set(indent, n + 1);
        marker = `${n}. `;
      }
      edits.push({ from: line.from + listAt(start), to: end, insert: marker });
    }
    return withEdits(state, edits);
  };
}

export const toggleBulletList = toggleList("bullet");
export const toggleOrderedList = toggleList("ordered");
export const toggleTaskList = toggleList("task");

/**
 * Nests the selected list items one level deeper, or brings them one level
 * out. A level is what puts an item under the one above it: that sibling's
 * marker and space. Numbered items renumber against their new level. Lines
 * that are not list items stay put — markdown has no indented paragraphs
 * (four spaces would make code).
 */
function shiftList(direction: 1 | -1): FormatCommand {
  return (state) => {
    const edits: Edit[] = [];
    const counters = new Map<number, number>();
    for (const line of textLines(state)) {
      const start = lineStart(line.text);
      if (!start.marker) continue;
      const indent = start.indent.length;
      let target: number;
      if (direction === 1) {
        const above = itemAbove(state, line, (i) => i <= indent);
        const sibling = above && above.indent.length === indent ? above : start;
        target = indent + sibling.marker.length + Math.max(1, sibling.markerSpace.length);
      } else {
        if (indent === 0) continue;
        target = itemAbove(state, line, (i) => i < indent)?.indent.length ?? 0;
      }
      const at = line.from + start.quote.length;
      if (!isOrdered(start.marker)) {
        edits.push({ from: at, to: at + indent, insert: " ".repeat(target) });
        continue;
      }
      const fallback = direction === 1 ? 1 : parseInt(start.marker, 10);
      const n = counters.get(target) ?? numberAfter(state, line, target, fallback);
      counters.set(target, n + 1);
      edits.push({
        from: at,
        to: at + indent + start.marker.length,
        insert: `${" ".repeat(target)}${n}${start.marker.slice(-1)}`,
      });
    }
    return withEdits(state, edits);
  };
}

export const indentList = shiftList(1);
export const outdentList = shiftList(-1);

// --------------------------------------------------------- clear formatting

const CLEARED: Record<string, string> = {
  Emphasis: "EmphasisMark",
  StrongEmphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  InlineCode: "CodeMark",
  Link: "LinkMark",
};

/** A formatting node's syntax out; a link keeps its text and loses the rest. */
function strip(node: SyntaxNode): Edit[] {
  if (node.name !== "Link") return unwrap(node, CLEARED[node.name]);
  const marks = children(node, "LinkMark");
  if (marks.length < 2) return [];
  return [
    { from: node.from, to: marks[0].to },
    { from: marks[1].from, to: node.to },
  ];
}

/**
 * Takes emphasis, strikethrough, inline code and link syntax out of the
 * selection (their text stays) and turns its lines back into Normal text.
 * A bare caret clears the formatting around it and its line's style.
 * Wikilinks and images stay: they are content, not formatting.
 */
export const clearFormatting: FormatCommand = (state) => {
  const tree = markdownTree(state);
  const edits: Edit[] = [];
  for (const range of state.selection.ranges) {
    if (range.empty) {
      for (let node: SyntaxNode | null = tree.resolveInner(range.from, 1); node; node = node.parent) {
        if (node.name in CLEARED && node.from < range.from && range.from < node.to) edits.push(...strip(node));
      }
      continue;
    }
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(ref) {
        if (ref.to > range.from && ref.from < range.to && ref.name in CLEARED) edits.push(...strip(ref.node));
      },
    });
  }
  const inline = state.changes(dedupe(edits));
  const style = setParagraphStyle("normal")(state).changes;
  // Inline and line syntax never share characters, so the two combine.
  const changes = style ? inline.compose(state.changes(style).map(inline)) : inline;
  return { ...FORMAT, changes, selection: state.selection.map(changes, 1) };
};

// ------------------------------------------------------------------- state

export type FormatState = {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  quote: boolean;
  codeBlock: boolean;
  style: ParagraphStyle;
};

export const NO_FORMAT: FormatState = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  link: false,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  codeBlock: false,
  style: "normal",
};

/**
 * What the toolbar shows for the main selection: the formatting the caret is
 * inside (or the whole selection is — exactly when its button would take
 * that formatting off), and the paragraph style of the caret's line.
 */
export function formatState(state: EditorState, tree: Tree = markdownTree(state)): FormatState {
  const range = state.selection.main;
  const inline = (format: InlineFormat) => {
    const name = INLINE[format].node;
    if (range.empty) return enclosing(tree, range.from, range.from, name) !== null;
    const parts = segments(state, range.from, range.to);
    return parts.length > 0 && parts.every((part) => enclosing(tree, part.from, part.to, name) !== null);
  };

  const line = state.doc.lineAt(range.head);
  const start = lineStart(line.text);
  const content = Math.min(line.from + start.content, line.to);
  const block = (test: (node: SyntaxNode) => boolean) => ancestor(tree, content, -1, test) ?? ancestor(tree, content, 1, test);
  const codeBlock = block((n) => CODE_BLOCKS.has(n.name)) !== null;
  let list = listKind(start);
  const item = list ? null : block((n) => n.name === "ListItem");
  if (item) list = item.getChild("Task") ? "task" : item.parent?.name === "OrderedList" ? "ordered" : "bullet";
  const quote = start.quote.length > 0 || block((n) => QUOTES.has(n.name)) !== null;
  const heading = block((n) => /^(ATX|Setext)Heading[1-6]$/.test(n.name));
  const level = start.hashes ? start.hashes.length : heading ? Number(heading.name.slice(-1)) : 0;

  let style: ParagraphStyle = "normal";
  if (codeBlock) style = "codeblock";
  else if (level) style = `h${level}` as ParagraphStyle;
  else if (quote) style = "quote";

  return {
    bold: inline("bold"),
    italic: inline("italic"),
    strike: inline("strike"),
    code: inline("code"),
    link: (range.empty ? enclosing(tree, range.from, range.from, "Link") : enclosing(tree, range.from, range.to, "Link")) !== null,
    bullet: !codeBlock && list === "bullet",
    ordered: !codeBlock && list === "ordered",
    task: !codeBlock && list === "task",
    quote: !codeBlock && quote,
    codeBlock,
    style,
  };
}
