/**
 * Overlap resolution for the mindmap canvas.
 *
 * Lives in lib/ rather than beside the component because it is pure geometry
 * over positions, and pure geometry is the part worth pinning down with tests —
 * "no two pills sit on top of each other" is the guarantee the view rests on.
 */

/** Half-width and half-height of a node's pill, in graph units. */
export type Extent = { halfWidth: number; halfHeight: number };

/** The mutable subset of a simulation node this pass reads and writes. */
export type Positioned = {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  /** Set when the user has placed the node by hand; such nodes never move. */
  fx?: number;
  fy?: number;
};

/** Clear space kept between two pills, in graph units. */
export const PILL_GAP = 6;

/**
 * Overlap below this is treated as none, in graph units.
 *
 * Without it, a pair pushed to exactly `PILL_GAP` apart lands a hair inside the
 * threshold on the next comparison, reports movement, and the fixed-point loop
 * below never converges — it burns every pass on corrections far too small to
 * see. A hundredth of a unit is well under a pixel at any usable zoom.
 */
const EPSILON = 0.01;

export function isPinned(node: Positioned): boolean {
  return node.fx !== undefined || node.fy !== undefined;
}

/**
 * Pushes overlapping pills apart, once, in place. Returns whether anything
 * moved, so callers can iterate to a fixed point.
 *
 * d3's own collision force is circular, which is a poor fit for wide pills — a
 * circle big enough to contain "Landlord Responsibilities" leaves a crater
 * around it. This compares the actual rectangles and separates each overlapping
 * pair along whichever axis needs the least movement.
 *
 * Velocity is corrected alongside position so that whatever pushed the two
 * together — usually a link spring — does not immediately do it again, which is
 * what would otherwise show up as jitter.
 *
 * O(n²) per pass. A vault's mindmap is tens to a few hundred nodes, and the
 * early-out on the x axis rejects almost every pair before it does real work.
 */
export function separateOnce<T extends Positioned>(
  nodes: T[],
  extentOf: (node: T) => Extent,
  strength: number,
): boolean {
  let moved = false;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const ea = extentOf(a);
    const aFixed = isPinned(a);

    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const eb = extentOf(b);

      const dx = (b.x ?? 0) - (a.x ?? 0);
      const overlapX = ea.halfWidth + eb.halfWidth + PILL_GAP - Math.abs(dx);
      if (overlapX <= EPSILON) continue;

      const dy = (b.y ?? 0) - (a.y ?? 0);
      const overlapY = ea.halfHeight + eb.halfHeight + PILL_GAP - Math.abs(dy);
      if (overlapY <= EPSILON) continue;

      // A pinned node does not move, so the other one absorbs the whole
      // correction rather than the pair splitting it.
      const bFixed = isPinned(b);
      if (aFixed && bFixed) continue;

      const shareA = aFixed ? 0 : bFixed ? 1 : 0.5;
      const shareB = bFixed ? 0 : aFixed ? 1 : 0.5;

      if (overlapX < overlapY) {
        // dx === 0 means perfectly stacked; pick a side deterministically.
        const push = overlapX * strength * (dx < 0 ? -1 : 1);
        a.x = (a.x ?? 0) - push * shareA;
        b.x = (b.x ?? 0) + push * shareB;
        a.vx = (a.vx ?? 0) - push * shareA;
        b.vx = (b.vx ?? 0) + push * shareB;
      } else {
        const push = overlapY * strength * (dy < 0 ? -1 : 1);
        a.y = (a.y ?? 0) - push * shareA;
        b.y = (b.y ?? 0) + push * shareB;
        a.vy = (a.vy ?? 0) - push * shareA;
        b.vy = (b.vy ?? 0) + push * shareB;
      }

      moved = true;
    }
  }

  return moved;
}

/** How many full-strength passes `resolveOverlaps` will attempt. */
export const MAX_RESOLVE_PASSES = 600;

/**
 * Separates pills until none of them overlap, which is what the canvas does
 * once the simulation has stopped: with no more ticks coming, nothing else will
 * integrate a residual overlap away.
 *
 * It stops at the guarantee that matters — nothing visibly overlapping — rather
 * than at the stricter "every pair has its full `PILL_GAP`", which costs many
 * times more passes to reach and looks no different.
 *
 * The cap exists for the degenerate case of a large pile of nodes at one point,
 * which pairwise separation unpicks only a little at a time. A settled force
 * layout is nowhere near that, so in practice this returns in a few dozen
 * passes; hitting the cap leaves the map improved rather than perfect, and
 * never hangs.
 */
export function resolveOverlaps<T extends Positioned>(
  nodes: T[],
  extentOf: (node: T) => Extent,
): void {
  for (let pass = 0; pass < MAX_RESOLVE_PASSES; pass++) {
    if (!separateOnce(nodes, extentOf, 1)) return;
    if (!hasOverlap(nodes, extentOf)) return;
  }
}

/**
 * A force pulling every node gently toward the origin, for d3 to run each tick.
 *
 * The vault-wide map is usually several disconnected clusters — notes that
 * share no concept have nothing linking them. Repulsion pushes those clusters
 * apart and no link ever pulls them back, so they drift until the map is mostly
 * empty space with the content shrunk into the corners. This is the missing
 * counterweight.
 *
 * Scaled by `alpha` like every other d3 force, so it fades out as the layout
 * cools rather than slowly dragging a settled map inward.
 */
export function createGravityForce<T extends Positioned>(strength: number) {
  let nodes: T[] = [];

  const force = (alpha: number) => {
    const k = strength * alpha;
    for (const node of nodes) {
      node.vx = (node.vx ?? 0) - (node.x ?? 0) * k;
      node.vy = (node.vy ?? 0) - (node.y ?? 0) * k;
    }
  };

  force.initialize = (given: T[]) => {
    nodes = given;
  };

  return force;
}

/**
 * Whether any two pills currently overlap.
 *
 * Deliberately ignores `PILL_GAP`: this asks the visual question — are two
 * pills drawn on top of each other — not whether they are comfortably spaced.
 */
export function hasOverlap<T extends Positioned>(
  nodes: T[],
  extentOf: (node: T) => Extent,
): boolean {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const ea = extentOf(a);
      const eb = extentOf(b);

      const gapX = Math.abs((b.x ?? 0) - (a.x ?? 0)) - (ea.halfWidth + eb.halfWidth);
      const gapY = Math.abs((b.y ?? 0) - (a.y ?? 0)) - (ea.halfHeight + eb.halfHeight);
      if (gapX < 0 && gapY < 0) return true;
    }
  }
  return false;
}
