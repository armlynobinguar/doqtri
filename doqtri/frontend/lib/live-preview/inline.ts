import { previewParser } from "@/lib/live-preview/syntax";

/**
 * Inline markdown as a small tree, for content the editor renders outside its
 * own text flow — table cells, which a block widget draws as a grid.
 *
 * Only what reads differently once rendered: emphasis, strikethrough, code,
 * links and wikilinks. Images inside a cell show their alt text rather than
 * loading; a grid row is no place for a picture.
 */
export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em" | "del"; children: InlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: InlineNode[] }
  | { kind: "wikilink"; target: string; text: string };

type Element = { type: number; from: number; to: number; children?: Element[] };

const nameOf = (el: Element) => previewParser.nodeSet.types[el.type].name;

/** An element's children; the parser keeps them on a field it does not type. */
const childrenOf = (el: Element): Element[] => (Array.isArray(el.children) ? el.children : []);

/** Merges adjacent text runs, which the gap-filling below produces. */
function pushText(into: InlineNode[], text: string) {
  if (text.length === 0) return;
  const last = into[into.length - 1];
  if (last?.kind === "text") last.text += text;
  else into.push({ kind: "text", text });
}

const WRAPPERS: Record<string, "strong" | "em" | "del"> = {
  StrongEmphasis: "strong",
  Emphasis: "em",
  Strikethrough: "del",
};

/** The content of `el` between its marks, converted. */
function convertRange(text: string, from: number, to: number, elements: Element[]): InlineNode[] {
  const out: InlineNode[] = [];
  let at = from;
  for (const el of elements) {
    if (el.to <= from || el.from >= to) continue;
    pushText(out, text.slice(at, el.from));
    convert(text, el, out);
    at = el.to;
  }
  pushText(out, text.slice(at, to));
  return out;
}

function convert(text: string, el: Element, out: InlineNode[]) {
  const name = nameOf(el);
  const kids = childrenOf(el);

  if (name in WRAPPERS) {
    const marks = kids.filter((kid) => nameOf(kid).endsWith("Mark"));
    const from = marks[0]?.to ?? el.from;
    const to = marks.length > 1 ? marks[marks.length - 1].from : el.to;
    out.push({ kind: WRAPPERS[name], children: convertRange(text, from, to, kids) });
    return;
  }

  switch (name) {
    case "InlineCode": {
      const marks = kids.filter((kid) => nameOf(kid) === "CodeMark");
      const from = marks[0]?.to ?? el.from;
      const to = marks.length > 1 ? marks[marks.length - 1].from : el.to;
      out.push({ kind: "code", text: text.slice(from, to).trim() || text.slice(from, to) });
      return;
    }
    case "Link":
    case "Image": {
      const marks = kids.filter((kid) => nameOf(kid) === "LinkMark");
      const from = marks[0]?.to ?? el.from;
      const to = marks[1]?.from ?? el.to;
      if (name === "Image") {
        pushText(out, text.slice(from, to));
        return;
      }
      const url = kids.find((kid) => nameOf(kid) === "URL");
      // A reference-style `[text]` with nothing to resolve it is prose.
      if (!url) {
        pushText(out, text.slice(el.from, el.to));
        return;
      }
      out.push({
        kind: "link",
        href: text.slice(url.from, url.to),
        children: convertRange(text, from, to, kids.filter((kid) => nameOf(kid) !== "LinkMark")),
      });
      return;
    }
    case "WikiLink": {
      const target = kids.find((kid) => nameOf(kid) === "WikiLinkTarget");
      const targetText = target ? text.slice(target.from, target.to).trim() : "";
      const inner = text.slice(el.from + 2, el.to - 2);
      const pipe = inner.indexOf("|");
      out.push({
        kind: "wikilink",
        target: targetText,
        text: pipe >= 0 ? inner.slice(pipe + 1).trim() || targetText : targetText,
      });
      return;
    }
    case "Escape":
      pushText(out, text.slice(el.from + 1, el.to));
      return;
    case "URL":
    case "Autolink": {
      const url = name === "URL" ? el : kids.find((kid) => nameOf(kid) === "URL");
      const href = url ? text.slice(url.from, url.to) : text.slice(el.from, el.to);
      out.push({ kind: "link", href, children: [{ kind: "text", text: href }] });
      return;
    }
    default:
      pushText(out, text.slice(el.from, el.to));
  }
}

/** `text` (one table cell, say) as rendered inline nodes. */
export function inlineNodes(text: string): InlineNode[] {
  const elements = previewParser.parseInline(text, 0) as unknown as Element[];
  return convertRange(text, 0, text.length, elements);
}

/** The text a reader sees, formatting dropped: whether a cell renders 1:1. */
export function plainText(nodes: InlineNode[]): string {
  return nodes
    .map((node) =>
      node.kind === "text" || node.kind === "code" || node.kind === "wikilink"
        ? node.text
        : plainText(node.children),
    )
    .join("");
}
