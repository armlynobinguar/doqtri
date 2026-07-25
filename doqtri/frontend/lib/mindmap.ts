export type MindmapNode = {
  id: string;
  label: string;
  children: MindmapNode[];
};

/** ATX headings only: `# ` through `###### `. */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Strips the [[ ]] syntax from a heading so `## [[Auth]] flow` reads as
 * "Auth flow" in the tree. The link itself still belongs to the global graph;
 * the mindmap is about structure.
 */
function cleanLabel(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias ?? target)
    .replace(/\s+#+\s*$/, "") // closing ATX hashes
    .trim();
}

/**
 * Builds the per-document mindmap from the heading hierarchy. Root is the
 * document title; `##` nests under the nearest preceding `#`, and so on.
 * Non-heading lines are ignored in v1.
 */
export function buildMindmap(title: string, markdown: string): MindmapNode {
  const root: MindmapNode = { id: "root", label: title, children: [] };

  // Level 0 is the root, so any heading (level >= 1) nests beneath it.
  const stack: { level: number; node: MindmapNode }[] = [{ level: 0, node: root }];
  let counter = 0;

  for (const line of markdown.split("\n")) {
    const match = HEADING_RE.exec(line);
    if (!match) continue;

    const level = match[1].length;
    const label = cleanLabel(match[2]);
    if (label.length === 0) continue;

    // Unwind to the nearest ancestor shallower than this heading. This also
    // handles skipped levels (# followed by ###) without creating gaps.
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const node: MindmapNode = {
      id: `h${counter++}`,
      label,
      children: [],
    };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ level, node });
  }

  return root;
}
