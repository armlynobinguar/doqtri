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

const ORIGIN = { x: 0, y: 0 };

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
 * Every node's extent, and the node indices sorted by left edge.
 *
 * The sweep below walks this order and stops looking for partners once the next
 * pill starts to the right of the current one's right edge — anything further
 * along starts later still, so it cannot overlap either. That turns the pair
 * scan from every-node-against-every-node into roughly each node against its
 * horizontal neighbours, which is what lets maps of a thousand-plus nodes lay
 * out without stalling the page.
 */
function sweepOrder<T extends Positioned>(nodes: T[], extentOf: (node: T) => Extent) {
  const extents = nodes.map(extentOf);
  const left = nodes.map((node, i) => (node.x ?? 0) - extents[i].halfWidth);
  const order = nodes.map((_, i) => i).sort((i, j) => left[i] - left[j]);
  return { extents, order };
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
 * Pairs are found by a sweep over the left edges (see `sweepOrder`). Pushes
 * made during the pass can leave the order slightly stale, so a pair nudged
 * into contact mid-pass may wait for the next one; callers already iterate.
 */
export function separateOnce<T extends Positioned>(
  nodes: T[],
  extentOf: (node: T) => Extent,
  strength: number,
): boolean {
  const { extents, order } = sweepOrder(nodes, extentOf);
  let moved = false;

  for (let oi = 0; oi < order.length; oi++) {
    const a = nodes[order[oi]];
    const ea = extents[order[oi]];
    const aFixed = isPinned(a);

    for (let oj = oi + 1; oj < order.length; oj++) {
      const b = nodes[order[oj]];
      const eb = extents[order[oj]];

      // Past this point every pill starts beyond a's right edge plus the gap.
      const reach = (a.x ?? 0) + ea.halfWidth + PILL_GAP;
      if ((b.x ?? 0) - eb.halfWidth - reach >= EPSILON) break;

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
 * `resolveOverlaps`, in slices: each `step` runs passes for at most `budgetMs`
 * and returns true once the map is clean or the pass cap is spent.
 *
 * On a thousand-node map the full resolve can take most of a second, which as
 * one synchronous call is a frozen page. Spread over animation frames, the
 * same work leaves every frame short. The pass cap is shared across slices, so
 * a degenerate pile still ends.
 */
export function createOverlapResolver<T extends Positioned>(
  nodes: T[],
  extentOf: (node: T) => Extent,
  now: () => number = () => performance.now(),
) {
  let passes = 0;
  let done = false;

  return function step(budgetMs: number): boolean {
    if (done) return true;
    const deadline = now() + budgetMs;
    do {
      if (passes >= MAX_RESOLVE_PASSES) return (done = true);
      passes++;
      if (!separateOnce(nodes, extentOf, 1) || !hasOverlap(nodes, extentOf)) return (done = true);
    } while (now() < deadline);
    return false;
  };
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
export function createGravityForce<T extends Positioned>(
  strength: number,
  /**
   * Where each node is pulled to. Defaults to the origin; a map laid out as
   * separate groups pulls each node to its own group's centre instead, which
   * keeps unrelated groups apart rather than gathering them into one heap.
   */
  centreOf: (node: T) => { x: number; y: number } = () => ORIGIN,
) {
  let nodes: T[] = [];

  const force = (alpha: number) => {
    const k = strength * alpha;
    for (const node of nodes) {
      const centre = centreOf(node);
      node.vx = (node.vx ?? 0) - ((node.x ?? 0) - centre.x) * k;
      node.vy = (node.vy ?? 0) - ((node.y ?? 0) - centre.y) * k;
    }
  };

  force.initialize = (given: T[]) => {
    nodes = given;
  };

  return force;
}

/**
 * A force holding each node on a ring at `depth * levelDistance` from the
 * origin, which is what lays a single concept tree out radially.
 *
 * force-graph has this built in (`dagMode="radialout"`), but it looks a node's
 * ring up as `depth || -1`, so the root — depth 0 — is aimed at radius -70.
 * Every tick that flings the root across the origin, its links drag the rest of
 * the tree after it, and the whole map shakes until the simulation cools. The
 * depth already sits on every node, so this reads it directly, and the root is
 * pulled to the centre instead.
 *
 * Same formula as d3's forceRadial otherwise, scaled by `alpha` so it fades out
 * as the layout settles.
 */
export function createRadialForce<T extends Positioned & { depth: number }>(
  levelDistance: number,
  /** Each node's ring and the centre it rings; by default its depth, around the origin. */
  placeOf: (node: T) => { ring: number; x: number; y: number } = (node) => ({ ring: node.depth, ...ORIGIN }),
) {
  let nodes: T[] = [];

  const force = (alpha: number) => {
    for (const node of nodes) {
      const place = placeOf(node);
      const x = (node.x ?? 0) - place.x;
      const y = (node.y ?? 0) - place.y;
      // A node exactly on its centre has no direction to be pushed in; a
      // hair of distance keeps the division finite, and it only happens once.
      const r = Math.hypot(x, y) || 1e-6;
      const k = ((place.ring * levelDistance - r) * alpha) / r;
      node.vx = (node.vx ?? 0) + x * k;
      node.vy = (node.vy ?? 0) + y * k;
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
 * Nothing moves here, so the sweep is exact.
 */
export function hasOverlap<T extends Positioned>(
  nodes: T[],
  extentOf: (node: T) => Extent,
): boolean {
  const { extents, order } = sweepOrder(nodes, extentOf);
  for (let oi = 0; oi < order.length; oi++) {
    const a = nodes[order[oi]];
    const ea = extents[order[oi]];
    const right = (a.x ?? 0) + ea.halfWidth;
    for (let oj = oi + 1; oj < order.length; oj++) {
      const b = nodes[order[oj]];
      const eb = extents[order[oj]];
      if ((b.x ?? 0) - eb.halfWidth >= right) break;

      const gapX = Math.abs((b.x ?? 0) - (a.x ?? 0)) - (ea.halfWidth + eb.halfWidth);
      const gapY = Math.abs((b.y ?? 0) - (a.y ?? 0)) - (ea.halfHeight + eb.halfHeight);
      if (gapX < 0 && gapY < 0) return true;
    }
  }
  return false;
}

/**
 * Starting positions that already look like the finished map: a radial tree,
 * each node on the ring for its depth, inside the slice of the circle its
 * parent was given, slices sized by how many leaves each branch carries.
 *
 * Left to start from force-graph's default spiral, a big map settles with
 * children nowhere near their parents — the ring force holds every node at
 * the right distance from the centre, and nothing can pass another node on
 * its ring to get home, so links criss-cross the whole map. From here the
 * forces only tidy up.
 *
 * A forest (the global map) gets a virtual centre, so its roots share the
 * first ring instead of piling up at the origin.
 */
export function seedRadialPositions(
  nodes: { id: string; depth: number }[],
  links: { source: string; target: string }[],
  ringDistance: number,
): Map<string, { x: number; y: number }> {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const { source, target } of links) {
    if (hasParent.has(target)) continue; // first parent wins: a tree, not a graph
    hasParent.add(target);
    (children.get(source) ?? children.set(source, []).get(source)!).push(target);
  }

  const roots = nodes.filter((node) => !hasParent.has(node.id)).map((node) => node.id);
  const VIRTUAL = "\u0000root";
  const forest = roots.length !== 1;
  if (forest) children.set(VIRTUAL, roots);
  const top = forest ? VIRTUAL : roots[0];

  // Leaves under each node, iteratively so a deep map cannot overflow the stack.
  const leaves = new Map<string, number>();
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = top === undefined ? [] : [top];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const kids = (children.get(id) ?? []).filter((kid) => seen.has(kid));
    leaves.set(id, kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + (leaves.get(kid) ?? 1), 0));
  }

  const positions = new Map<string, { x: number; y: number }>();
  const placed = new Set<string>();
  const queue: { id: string; ring: number; from: number; to: number }[] =
    top === undefined ? [] : [{ id: top, ring: 0, from: -Math.PI / 2, to: (3 * Math.PI) / 2 }];
  while (queue.length > 0) {
    const { id, ring, from, to } = queue.shift()!;
    if (placed.has(id)) continue;
    placed.add(id);
    const mid = (from + to) / 2;
    if (id !== VIRTUAL) {
      positions.set(id, { x: Math.cos(mid) * ring * ringDistance, y: Math.sin(mid) * ring * ringDistance });
    }
    const kids = (children.get(id) ?? []).filter((kid) => !placed.has(kid));
    const total = kids.reduce((sum, kid) => sum + (leaves.get(kid) ?? 1), 0) || 1;
    let start = from;
    for (const kid of kids) {
      const span = ((to - from) * (leaves.get(kid) ?? 1)) / total;
      queue.push({ id: kid, ring: ring + 1, from: start, to: start + span });
      start += span;
    }
  }

  // Anything unreachable (a cycle with no way in) waits at the centre.
  for (const node of nodes) if (!positions.has(node.id)) positions.set(node.id, { x: 0, y: 0 });
  return positions;
}

/**
 * The map's connected groups: nodes that reach one another through links,
 * ignoring direction. Two notes that share no concept, even indirectly, end
 * up in different groups. Groups come back in the order their first node
 * appears, each listing its nodes in input order.
 */
export function connectedComponents(
  nodes: { id: string }[],
  links: { source: string; target: string }[],
): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path halving keeps later lookups short.
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const node of nodes) parent.set(node.id, node.id);
  for (const { source, target } of links) {
    if (!parent.has(source) || !parent.has(target)) continue;
    const a = find(source);
    const b = find(target);
    if (a !== b) parent.set(b, a);
  }

  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node.id);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(node.id);
  }
  return [...groups.values()];
}

/**
 * Places circles of the given radii so that none overlap, keeping the whole
 * arrangement compact. The largest goes in the middle; each next one, largest
 * first, takes the first free spot along a spiral out from the centre.
 * Deterministic, and returns centres in the input order.
 */
export function packCircles(radii: number[], gap: number): { x: number; y: number }[] {
  const order = radii.map((_, i) => i).sort((a, b) => radii[b] - radii[a]);
  const placed: { x: number; y: number; r: number }[] = [];
  const centres: { x: number; y: number }[] = new Array(radii.length);

  for (const index of order) {
    const r = radii[index];
    let spot = { x: 0, y: 0 };
    if (placed.length > 0) {
      // Archimedean spiral, stepped finely enough relative to the circle size
      // that a gap the circle fits in is not stepped over.
      // The spiral moves out one step per turn; the angle advances so that
      // successive candidates are about a step apart at any radius.
      const step = Math.max(4, r / 4);
      for (let t = 0; ; ) {
        const distance = (step * t) / (2 * Math.PI);
        const candidate = { x: Math.cos(t) * distance, y: Math.sin(t) * distance };
        if (placed.every((c) => Math.hypot(c.x - candidate.x, c.y - candidate.y) >= c.r + r + gap)) {
          spot = candidate;
          break;
        }
        t += Math.min(0.5, step / Math.max(distance, step));
      }
    }
    placed.push({ ...spot, r });
    centres[index] = spot;
  }
  return centres;
}

/** Where a node sits in a grouped layout: its start, its group's centre, and its ring there. */
export type GroupedPlace = { x: number; y: number; centreX: number; centreY: number; ring: number };

/**
 * Lays a map out as separate groups that never overlap: each connected group
 * becomes its own radial tree, sized by how far it reaches, and the groups
 * are packed side by side (see `packCircles`). A map that is one group is
 * just its radial tree around the origin.
 *
 * The returned centre and ring are what the layout forces hold each node to
 * afterwards, so the groups stay apart once the simulation starts.
 */
export function layoutGroups(
  nodes: { id: string; depth: number }[],
  links: { source: string; target: string }[],
  ringDistance: number,
  /** Room left around each group for its pills' width, in graph units. */
  margin = 60,
): Map<string, GroupedPlace> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const groups = connectedComponents(nodes, links);
  const seeds = groups.map((ids) => {
    const members = new Set(ids);
    const groupNodes = ids.map((id) => byId.get(id)!);
    const groupLinks = links.filter((link) => members.has(link.source) && members.has(link.target));
    const seed = seedRadialPositions(groupNodes, groupLinks, ringDistance);
    let reach = 0;
    for (const { x, y } of seed.values()) reach = Math.max(reach, Math.hypot(x, y));
    return { seed, radius: reach + margin };
  });
  const centres = packCircles(
    seeds.map((s) => s.radius),
    margin,
  );

  const places = new Map<string, GroupedPlace>();
  seeds.forEach(({ seed }, g) => {
    const centre = centres[g];
    for (const [id, at] of seed) {
      places.set(id, {
        x: at.x + centre.x,
        y: at.y + centre.y,
        centreX: centre.x,
        centreY: centre.y,
        // The seed put each node on a ring; the forces keep it there. Reading
        // the ring back from the seed covers a group with several roots, whose
        // roots sit on the first ring rather than all at the centre.
        ring: Math.round(Math.hypot(at.x, at.y) / ringDistance),
      });
    }
  });
  return places;
}

/** A label that may be drawn enlarged: its centre, natural half-size, and the enlargement it wants. */
export type BoostItem = {
  id: string;
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  want: number;
  /** Higher keeps more of its enlargement when two collide. */
  priority: number;
};

/**
 * How much each label may actually be enlarged without running into another.
 *
 * Zoomed far out, outline labels are drawn bigger than the layout made room
 * for (see `labelBoost`). Like a map dropping or shrinking labels that would
 * collide, this places labels one at a time — first those that are not
 * enlarged, which cannot give way, then the rest by priority — and shrinks
 * each enlargement until it clears everything already placed, never below
 * natural size.
 */
export function fitBoosts(items: BoostItem[], gap: number): Map<string, number> {
  const order = [...items].sort((a, b) => {
    const fixedA = a.want <= 1 ? 1 : 0;
    const fixedB = b.want <= 1 ? 1 : 0;
    return fixedB - fixedA || b.priority - a.priority;
  });
  const placed: { x: number; y: number; hw: number; hh: number }[] = [];
  const result = new Map<string, number>();
  const clashes = (x: number, y: number, hw: number, hh: number) =>
    placed.some((p) => Math.abs(p.x - x) < p.hw + hw + gap && Math.abs(p.y - y) < p.hh + hh + gap);

  for (const item of order) {
    let boost = Math.max(1, item.want);
    while (boost > 1 && clashes(item.x, item.y, item.halfWidth * boost, item.halfHeight * boost)) {
      boost = boost * 0.85 < 1.02 ? 1 : boost * 0.85;
    }
    result.set(item.id, boost);
    placed.push({ x: item.x, y: item.y, hw: item.halfWidth * boost, hh: item.halfHeight * boost });
  }
  return result;
}
