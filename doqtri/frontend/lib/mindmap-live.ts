import { normalizeConcept, type ConceptNode, type DocMindmap } from "@/lib/mindmap-types";

/**
 * The live heading map beside the editor: what keeps it steady while the note
 * is being typed.
 *
 * The heading tree's own ids are positional (`h0`, `h1`, … in document order),
 * so inserting a heading near the top renumbers everything below it. Matched
 * by those ids, every node after the insertion would jump to its neighbour's
 * place. The live map instead names each node by the path of heading labels
 * from the root, which only changes for the heading actually edited.
 */

/** Joins label-path segments; a heading label never contains a newline. */
const SEPARATOR = "\n";

/**
 * How far out of its parent a new node starts, as a share of a ring, when it
 * animates in. Close enough to read as growing out of the parent; not so
 * close that the layout's repulsion, which grows as distance shrinks, flings
 * it across the map on the first tick.
 */
const GROW_FROM = 0.35;

/** The root keeps one id whatever the note is called, so a rename moves nothing. */
export const LIVE_ROOT_ID = "root";

/**
 * The same tree with every id replaced by its label path. Labels compare as
 * concepts do (case and spacing ignored); siblings with the same label are
 * told apart by their order (`Notes`, `Notes#2`).
 */
export function withLabelPathIds(mindmap: DocMindmap): DocMindmap {
  function walk(node: ConceptNode, path: string): ConceptNode {
    const seen = new Map<string, number>();
    return {
      ...node,
      id: path,
      children: node.children.map((child) => {
        const label = normalizeConcept(child.label);
        const count = (seen.get(label) ?? 0) + 1;
        seen.set(label, count);
        const segment = count === 1 ? label : `${label}#${count}`;
        return walk(child, path === LIVE_ROOT_ID ? segment : `${path}${SEPARATOR}${segment}`);
      }),
    };
  }
  return { ...mindmap, root: walk(mindmap.root, LIVE_ROOT_ID) };
}

export type Point = { x: number; y: number };

/** A node's state on the canvas the last time the map was drawn. */
export type PlacedNode = Point & {
  /** Set when pinned; a pin the user placed by hand survives a rebuild. */
  fx?: number;
  fy?: number;
};

export type CarriedNode = Point & {
  /** Pinned where it stands while the new nodes find their place. */
  fx?: number;
  fy?: number;
  /** Not on the previous map: it grows out of its parent. */
  fresh: boolean;
};

/**
 * Starting positions for a rebuilt map, given the previous one.
 *
 * Nodes that were on the previous map start exactly where they were, pinned
 * there so the layout forces only move the new ones. A new node belongs a ring
 * further out than its parent, in the direction the parent faces from the
 * centre: it starts a short way along that line and grows out as the layout
 * runs or, with `instant`, starts there, so nothing needs to animate at all.
 *
 * Returns null when no node carries over: that is a different map, which
 * gets a fresh layout.
 */
export function carryLayout(
  previous: ReadonlyMap<string, PlacedNode>,
  nodes: readonly { id: string }[],
  links: readonly { source: string; target: string }[],
  fallback: ReadonlyMap<string, Point>,
  options: { instant: boolean; ringDistance: number },
): Map<string, CarriedNode> | null {
  if (!nodes.some((node) => previous.has(node.id))) return null;

  const parentOf = new Map<string, string>();
  for (const { source, target } of links) if (!parentOf.has(target)) parentOf.set(target, source);

  // The centre the map grows away from: where the root sits.
  const roots = nodes.filter((node) => !parentOf.has(node.id));
  const rootPlaced = roots.map((root) => previous.get(root.id)).find(Boolean);
  const centre: Point = rootPlaced ?? { x: 0, y: 0 };

  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(child);
  }

  const carried = new Map<string, CarriedNode>();
  const place = (id: string) => {
    const before = previous.get(id);
    if (before) {
      carried.set(id, {
        x: before.x,
        y: before.y,
        fx: before.fx ?? before.x,
        fy: before.fy ?? before.y,
        fresh: false,
      });
      return;
    }

    const parentId = parentOf.get(id);
    const parent = parentId ? carried.get(parentId) : undefined;
    const siblings = parentId ? (childrenOf.get(parentId) ?? []) : [];

    let at: Point;
    if (!parent) {
      at = fallback.get(id) ?? centre;
    } else {
      // Where it belongs: a ring further out than its parent, in the
      // direction the parent faces from the centre, siblings fanned out.
      const index = Math.max(0, siblings.indexOf(id));
      const dx = parent.x - centre.x;
      const dy = parent.y - centre.y;
      const length = Math.hypot(dx, dy);
      // The root faces every way; fan its new children around the circle.
      const angle = length < 1 ? (index / Math.max(1, siblings.length)) * Math.PI * 2 : Math.atan2(dy, dx);
      const spread = length < 1 ? 0 : (index - (siblings.length - 1) / 2) * 0.35;
      const reach = options.instant ? options.ringDistance : options.ringDistance * GROW_FROM;
      at = {
        x: parent.x + Math.cos(angle + spread) * reach,
        y: parent.y + Math.sin(angle + spread) * reach,
      };
    }

    carried.set(id, { ...at, fresh: true });
  };

  // Parents before children, so a chain of new headings grows outward one
  // by one; anything the walk cannot reach is placed after.
  const queue = roots.map((root) => root.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (carried.has(id)) continue;
    place(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  for (const node of nodes) if (!carried.has(node.id)) place(node.id);
  return carried;
}
