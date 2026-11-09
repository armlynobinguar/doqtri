import type { Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

/**
 * Links a reader can follow from the editor: ⌘/Ctrl-click (or a plain click
 * where the note cannot be edited), or Mod-Enter with the caret inside one.
 *
 * Only `http:`, `https:` and `mailto:` addresses open, in a new tab with no
 * opener and no referrer. Anything else — `javascript:`, `data:`, a relative
 * path into the app — does nothing, for the same reasons images only load
 * from http(s) (see image.ts). Wikilinks open the note they name.
 */

export type LinkTarget = { kind: "url"; url: string } | { kind: "wiki"; title: string };

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

/** The address a link may open, normalized, or null if it must not open. */
export function openableLinkUrl(raw: string): string | null {
  let url = raw.trim().replace(/^<(.*)>$/, "$1");
  // GFM reads `www.example.com` as a link; it means the web address.
  if (/^www\./i.test(url)) url = `https://${url}`;
  else if (!/^mailto:/i.test(url) && EMAIL.test(url)) url = `mailto:${url}`;
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "mailto:") return parsed.pathname.includes("@") ? parsed.href : null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function child(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let kid = node.firstChild; kid; kid = kid.nextSibling) if (kid.name === name) return kid;
  return null;
}

function targetOf(node: SyntaxNode, doc: Text): LinkTarget | null | undefined {
  switch (node.name) {
    case "WikiLink": {
      const target = child(node, "WikiLinkTarget");
      const title = target ? doc.sliceString(target.from, target.to).trim() : "";
      return title ? { kind: "wiki", title } : null;
    }
    case "Link": {
      // A reference-style `[text]` resolves to nothing (see decorations.ts).
      const url = child(node, "URL");
      const href = url ? openableLinkUrl(doc.sliceString(url.from, url.to)) : null;
      return href ? { kind: "url", url: href } : null;
    }
    case "Autolink": {
      const url = child(node, "URL");
      const href = url ? openableLinkUrl(doc.sliceString(url.from, url.to)) : null;
      return href ? { kind: "url", url: href } : null;
    }
    case "URL": {
      // A bare URL; inside a link or autolink, the parent decides.
      const parent = node.parent?.name;
      if (parent === "Link" || parent === "Autolink" || parent === "Image") return undefined;
      const href = openableLinkUrl(doc.sliceString(node.from, node.to));
      return href ? { kind: "url", url: href } : null;
    }
    case "Image":
      // An image is not a link; clicking it edits it.
      return null;
  }
  return undefined;
}

/** The link at document position `pos`, if any, and whether it may be followed. */
export function linkAt(tree: Tree, doc: Text, pos: number): LinkTarget | null {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const target = targetOf(node, doc);
      if (target !== undefined) {
        // A position at a link's very edge belongs to the text beside it.
        if (pos <= node.from && side === -1) break;
        if (pos >= node.to && side === 1) break;
        return target;
      }
    }
  }
  return null;
}
