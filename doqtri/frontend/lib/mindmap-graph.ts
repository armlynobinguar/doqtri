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

/**
 * Above this share of the map, focusing on a node dims nothing: lighting up
 * nearly everything (hovering the root, say) only adds a flicker.
 */
export const FOCUS_MAX_SHARE = 0.8;

/**
 * For any node, the nodes it is related to: itself, everything below it, and
 * the path back up to the root.
 *
 * The descendants are what the node is about; the ancestors say where it sits
 * in the map, which a highlighted branch floating alone would lose. A node with
 * several parents — a hub in the global map — keeps every route upward.
 *
 * The adjacency is built once per graph; each lookup walks only the nodes it
 * returns. Returns null when the related set covers too much of the map to be
 * worth dimming the rest.
 */
export function createFocusIndex(graph: MindmapGraph): (id: string) => Set<string> | null {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const { source, target } of graph.links) {
    (children.get(source) ?? children.set(source, []).get(source)!).push(target);
    (parents.get(target) ?? parents.set(target, []).get(target)!).push(source);
  }
  const total = graph.nodes.length;

  function walk(start: string, edges: Map<string, string[]>, into: Set<string>) {
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const next of edges.get(id) ?? []) {
        if (into.has(next)) continue;
        into.add(next);
        stack.push(next);
      }
    }
  }

  return (id) => {
    const related = new Set<string>([id]);
    walk(id, children, related);
    walk(id, parents, related);
    return related.size > total * FOCUS_MAX_SHARE ? null : related;
  };
}

/** Below this many nodes a map is drawn whole at every zoom. */
export const ZOOM_REVEAL_MIN_NODES = 150;

/**
 * How much of a node to draw for its label's on-screen size — the map
 * equivalent of street names appearing only once you zoom in.
 *
 * The root and its first ring always show: they are the map's outline. Each
 * level below needs a larger on-screen label than the one above it before it
 * appears, so zooming in reveals the map a level at a time instead of all at
 * once, and each level fades in over a short range rather than popping.
 *
 * `fontPx` is the label's height in CSS pixels at the current zoom. Returns
 * 0 (hidden) to 1 (fully drawn).
 */
export function revealAlpha(fontPx: number, depth: number): number {
  if (depth <= 1) return 1;
  const start = 4 + (depth - 2) * 3;
  const full = start + 3;
  return Math.min(1, Math.max(0, (fontPx - start) / (full - start)));
}
