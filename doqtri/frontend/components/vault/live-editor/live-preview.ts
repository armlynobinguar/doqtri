import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  previewSpecs,
  revealedLines,
  tableBlocks,
  touches,
  type DocRange,
  type PreviewWidget,
} from "@/lib/live-preview/decorations";
import { parseTable, type ParsedTable, type TableCell } from "@/lib/live-preview/table";
import { inlineNodes, plainText, type InlineNode } from "@/lib/live-preview/inline";

/**
 * The live preview: the editor's text reads as rendered markdown except on
 * the lines the caret or selection touches. The rules themselves are pure
 * and live in lib/live-preview; this file turns them into decorations.
 *
 * Two sources, because CodeMirror requires it: everything inside a line comes
 * from a view plugin, computed for the visible part of the note only, while
 * tables — a block widget replacing several lines — come from a state field,
 * the only place a decoration may replace line breaks.
 */

const focusEffect = StateEffect.define<boolean>();

/** Whether the editor has focus, kept in state so the table field can see it. */
const focusField = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const effect of tr.effects) if (effect.is(focusEffect)) focused = effect.value;
    return focused;
  },
});

const focusTracking = EditorView.focusChangeEffect.of((_state, focusing) => focusEffect.of(focusing));

/**
 * The ranges that show raw source. None while the editor is unfocused or
 * read-only: a note reads fully rendered until someone puts a caret in it,
 * and a note that cannot be edited never shows its syntax.
 */
function activeRanges(state: EditorState): readonly DocRange[] {
  if (state.readOnly || !state.field(focusField, false)) return [];
  return state.selection.ranges;
}

/** The parse tree, finished if that is quick, so a long note's tables are found. */
function treeOf(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, 25) ?? syntaxTree(state);
}

// ---------------------------------------------------------------- widgets

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-lp-bullet";
    dot.textContent = "•";
    dot.setAttribute("aria-hidden", "true");
    return dot;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const rule = document.createElement("span");
    rule.className = "cm-lp-hr";
    rule.setAttribute("role", "separator");
    return rule;
  }
}

class FenceWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(other: FenceWidget) {
    return other.lang === this.lang;
  }
  toDOM() {
    const label = document.createElement("span");
    label.className = "cm-lp-fence-label";
    label.textContent = this.lang;
    return label;
  }
  ignoreEvent() {
    return false;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.tabIndex = -1;
    box.setAttribute("aria-label", this.checked ? "Done" : "To do");
    box.disabled = view.state.readOnly;
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      // `[ ]` ↔ `[x]`: the one character between the brackets.
      const at = view.posAtDOM(box) + 1;
      view.dispatch({
        changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" },
        userEvent: "input.toggle",
      });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** Height kept for every image, loaded or not, so text below never moves. */
export const IMAGE_FRAME_HEIGHT = 240;

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly title: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.url === this.url && other.alt === this.alt && other.title === this.title;
  }
  get estimatedHeight() {
    return IMAGE_FRAME_HEIGHT;
  }
  toDOM() {
    const frame = document.createElement("span");
    frame.className = "cm-lp-image";
    frame.dataset.state = "loading";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    if (this.title) img.title = this.title;
    // A note's reader is nobody else's business: no Referer to the image host.
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    img.addEventListener("load", () => {
      frame.dataset.state = "loaded";
    });
    img.addEventListener("error", () => {
      frame.dataset.state = "broken";
      frame.replaceChildren(brokenImage(this.alt));
    });
    frame.appendChild(img);
    return frame;
  }
  ignoreEvent() {
    // Clicking the picture puts the caret on its line, which shows the source.
    return false;
  }
}

/** The alt text with a broken-image mark, in place of a picture that failed. */
function brokenImage(alt: string): HTMLElement {
  const row = document.createElement("span");
  row.className = "cm-lp-image-broken";
  row.setAttribute("role", "img");
  row.setAttribute("aria-label", `${alt || "Image"} (could not load)`);
  // lucide "image-off", inline so no React is needed inside the editor.
  row.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" x2="22" y1="2" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" x2="6" y1="13.5" y2="21"/><line x1="18" x2="21" y1="12" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg>';
  const text = document.createElement("span");
  text.textContent = alt || "Image";
  const hint = document.createElement("span");
  hint.className = "cm-lp-image-hint";
  hint.textContent = "could not load";
  row.append(text, hint);
  return row;
}

function widgetFor(spec: PreviewWidget): WidgetType {
  switch (spec.type) {
    case "bullet":
      return new BulletWidget();
    case "hr":
      return new RuleWidget();
    case "fence":
      return new FenceWidget(spec.lang);
    case "task":
      return new TaskWidget(spec.checked);
    case "image":
      return new ImageWidget(spec.url, spec.alt, spec.title);
  }
}

// ------------------------------------------------------- inline decorations

const hiddenMark = Decoration.replace({});

function buildInline(view: EditorView): DecorationSet {
  const { state } = view;
  const tree = syntaxTree(state);
  const revealed = revealedLines(state.doc, activeRanges(state), tableBlocks(tree, state.doc));
  const ranges: Range<Decoration>[] = [];
  for (const spec of previewSpecs(tree, state.doc, revealed, view.visibleRanges)) {
    switch (spec.kind) {
      case "hide":
        ranges.push(hiddenMark.range(spec.from, spec.to));
        break;
      case "mark":
        ranges.push(Decoration.mark({ class: spec.cls }).range(spec.from, spec.to));
        break;
      case "line":
        ranges.push(Decoration.line({ class: spec.cls }).range(spec.at));
        break;
      case "widget":
        ranges.push(Decoration.replace({ widget: widgetFor(spec.widget) }).range(spec.from, spec.to));
        break;
    }
  }
  return Decoration.set(ranges, true);
}

const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInline(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.startState.field(focusField, false) !== update.state.field(focusField, false) ||
        update.startState.readOnly !== update.state.readOnly ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildInline(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// ------------------------------------------------------------------ tables

function renderInline(nodes: InlineNode[], into: HTMLElement) {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        into.append(node.text);
        break;
      case "code": {
        const code = document.createElement("code");
        code.className = "cm-lp-code";
        code.textContent = node.text;
        into.append(code);
        break;
      }
      case "wikilink": {
        const link = document.createElement("span");
        link.className = "cm-lp-wikilink";
        link.textContent = node.text;
        into.append(link);
        break;
      }
      case "link": {
        // Styled as a link but inert: a click edits the table, as in the text.
        const link = document.createElement("span");
        link.className = "cm-lp-link";
        link.title = node.href;
        renderInline(node.children, link);
        into.append(link);
        break;
      }
      default: {
        const tag = node.kind === "strong" ? "strong" : node.kind === "em" ? "em" : "del";
        const el = document.createElement(tag);
        renderInline(node.children, el);
        into.append(el);
      }
    }
  }
}

/** Where in a cell's source a click lands, when the cell renders as typed. */
function caretInCell(cell: HTMLElement, event: MouseEvent): number | null {
  if (cell.dataset.plain !== "true") return null;
  const doc = cell.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(event.clientX, event.clientY);
    if (position) ({ offsetNode: node, offset } = position);
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(event.clientX, event.clientY);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || !cell.contains(node) || node.nodeType !== Node.TEXT_NODE) return null;
  // Text before the hit node within the cell, plus the offset into it.
  let before = 0;
  const walker = doc.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text && text !== node; text = walker.nextNode()) {
    before += text.textContent?.length ?? 0;
  }
  return before + offset;
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly table: ParsedTable,
  ) {
    super();
  }

  eq(other: TableWidget) {
    // Same text at the same place: the DOM can stay as it is.
    return (
      other.source === this.source &&
      other.table.header[0]?.from === this.table.header[0]?.from
    );
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-lp-table";

    const cell = (tag: "th" | "td", source: TableCell, column: number) => {
      const el = document.createElement(tag);
      const align = this.table.align[column];
      if (align) el.style.textAlign = align;
      el.dataset.from = String(source.from);
      el.dataset.to = String(source.to);
      const nodes = inlineNodes(source.text);
      el.dataset.plain = String(plainText(nodes) === source.text);
      renderInline(nodes, el);
      return el;
    };

    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    this.table.header.forEach((source, i) => headRow.append(cell("th", source, i)));
    head.append(headRow);
    const body = document.createElement("tbody");
    for (const row of this.table.rows) {
      const tr = document.createElement("tr");
      row.forEach((source, i) => tr.append(cell("td", source, i)));
      body.append(tr);
    }
    table.append(head, body);
    wrap.append(table);

    // A click shows the table's source with the caret in the clicked cell's
    // text, where the rendered text maps back onto it one to one.
    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>("th, td");
      event.preventDefault();
      let pos = this.table.header[0]?.from ?? 0;
      if (target) {
        const from = Number(target.dataset.from);
        const to = Number(target.dataset.to);
        const offset = caretInCell(target, event);
        pos = offset === null ? to : Math.min(from + offset, to);
      }
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: "select.pointer" });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent(event: Event) {
    // Mouse presses are ours (above); scrolling the grid sideways is the browser's.
    return event.type !== "mousedown";
  }
}

function tableLines(doc: Text, block: DocRange) {
  const lines = [];
  const last = doc.lineAt(block.to).number;
  for (let n = doc.lineAt(block.from).number; n <= last; n++) {
    const line = doc.line(n);
    lines.push({ text: line.text, from: line.from });
  }
  return lines;
}

function buildTables(state: EditorState): DecorationSet {
  const tree = treeOf(state);
  const active = activeRanges(state);
  const ranges: Range<Decoration>[] = [];
  for (const block of tableBlocks(tree, state.doc)) {
    if (active.some((range) => touches(range, block))) continue;
    const table = parseTable(tableLines(state.doc, block));
    if (!table) continue;
    ranges.push(
      Decoration.replace({
        widget: new TableWidget(state.sliceDoc(block.from, block.to), table),
        block: true,
      }).range(block.from, block.to),
    );
  }
  return Decoration.set(ranges);
}

const tablePreview = StateField.define<DecorationSet>({
  create: buildTables,
  update(decorations, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((effect) => effect.is(focusEffect)) ||
      tr.startState.readOnly !== tr.state.readOnly ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    ) {
      return buildTables(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The live preview, ready to add to an editor's extensions. */
export function livePreview(): Extension {
  return [focusField, focusTracking, inlinePreview, tablePreview];
}
