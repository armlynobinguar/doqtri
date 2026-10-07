import type { ConceptNode, DocMindmap } from "@/lib/mindmap-types";

/**
 * The flat graph the mindmap canvas draws.
 *
 * Both mindmap views produce this shape: the document view flattens one
 * concept tree, the global view merges many. Keeping the canvas on one input
 * type is what lets the two views share a renderer.
 */
export type MapNodeKind =
  | "root"
  | "theme"
  | "concept"
  | "detail"
  /** A whole document, in the global view. */
  | "document"
  /** A concept that appears in more than one document. */
  | "hub";

export type MapNode = {
  id: string;
  label: string;
  kind: MapNodeKind;
  /** Distance from the root, used for the radial layout and for sizing. */
  depth: number;
  /** Hover text. */
  summary?: string;
  /** Where a click goes, when the node stands for something openable. */
  href?: string;
};

export type MapLink = { source: string; target: string };

export type MindmapGraph = { nodes: MapNode[]; links: MapLink[] };

/**
 * Flattens one document's concept tree into the canvas shape.
 *
 * Node ids come straight from the tree, which is already unique within a
 * document. The global view prefixes them, since ids only have to be unique
 * within the graph being drawn.
 */
export function graphFromMindmap(mindmap: DocMindmap): MindmapGraph {
  const nodes: MapNode[] = [];
  const links: MapLink[] = [];

  function walk(node: ConceptNode, depth: number) {
    nodes.push({
      id: node.id,
      label: node.label,
      kind: node.kind,
      depth,
      ...(node.summary ? { summary: node.summary } : {}),
    });

    for (const child of node.children) {
      links.push({ source: node.id, target: child.id });
      walk(child, depth + 1);
    }
  }

  walk(mindmap.root, 0);
  return { nodes, links };
}

/** Above this many nodes, a map asks before it draws everything. */
export const LARGE_MAP_NODES = 400;

/** How many nodes the overview of a large map aims to show. */
export const OVERVIEW_BUDGET = 300;

/**
 * The shallowest levels of a map that fit in `budget` nodes.
 *
 * A big map is mostly leaves: the outline of a thousand-node document is a few
 * dozen sections and their subsections, and the rest is detail. Cutting by
 * depth keeps every branch and drops whole outer rings, so the overview still
 * reads as the same map rather than a random sample of it. The root level is
 * always kept, even when it alone is over budget.
 */
export function overviewGraph(
  graph: MindmapGraph,
  budget: number = OVERVIEW_BUDGET,
): { graph: MindmapGraph; depth: number } {
  const perDepth = new Map<number, number>();
  for (const node of graph.nodes) perDepth.set(node.depth, (perDepth.get(node.depth) ?? 0) + 1);
  const depths = [...perDepth.keys()].sort((a, b) => a - b);

  let depth = depths[0] ?? 0;
  let total = perDepth.get(depth) ?? 0;
  for (const next of depths.slice(1)) {
    const count = perDepth.get(next) ?? 0;
    if (total + count > budget) break;
    total += count;
    depth = next;
  }

  const nodes = graph.nodes.filter((node) => node.depth <= depth);
  const kept = new Set(nodes.map((node) => node.id));
  const links = graph.links.filter((link) => kept.has(link.source) && kept.has(link.target));
  return { graph: { nodes, links }, depth };
}
