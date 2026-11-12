import type { MapNode } from "@/lib/mindmap-graph";

/** How many matches the node search lists (the shared mindmap page, DOQ-53). */
export const SEARCH_RESULTS = 8;

const fold = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The nodes whose label contains `query`, case- and space-insensitively, best
 * first: labels that start with it, then the shallower node, then the shorter
 * label, then alphabetical. At most `limit`; none for a blank query.
 */
export function searchNodes(nodes: MapNode[], query: string, limit = SEARCH_RESULTS): MapNode[] {
  const needle = fold(query);
  if (!needle) return [];
  const hits: { node: MapNode; at: number }[] = [];
  for (const node of nodes) {
    const at = fold(node.label).indexOf(needle);
    if (at >= 0) hits.push({ node, at });
  }
  hits.sort(
    (a, b) =>
      Number(a.at !== 0) - Number(b.at !== 0) ||
      a.node.depth - b.node.depth ||
      a.node.label.length - b.node.label.length ||
      a.node.label.localeCompare(b.node.label),
  );
  return hits.slice(0, limit).map((hit) => hit.node);
}
