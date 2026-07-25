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
