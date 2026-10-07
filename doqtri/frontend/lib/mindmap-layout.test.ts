import { describe, expect, it } from "vitest";
import {
  PILL_GAP,
  connectedComponents,
  fitBoosts,
  layoutGroups,
  packCircles,
  createOverlapResolver,
  createRadialForce,
  hasOverlap,
  isPinned,
  resolveOverlaps,
  seedRadialPositions,
  separateOnce,
  type Extent,
  type Positioned,
} from "@/lib/mindmap-layout";

type Pill = Positioned & { w: number; h: number };

const extentOf = (node: Pill): Extent => ({
  halfWidth: node.w / 2,
  halfHeight: node.h / 2,
});

function pill(x: number, y: number, w = 40, h = 12): Pill {
  return { x, y, w, h };
}

/**
 * A tall, narrow pill. Pills separate along whichever axis needs the least
 * movement, so these are the shape that separates horizontally — which is what
 * the tests below want to make assertions about.
 */
function tall(x: number, y: number): Pill {
  return { x, y, w: 12, h: 120 };
}

describe("isPinned", () => {
  it("is true once either axis is fixed", () => {
    expect(isPinned({ x: 0, y: 0 })).toBe(false);
    expect(isPinned({ x: 0, y: 0, fx: 0 })).toBe(true);
    expect(isPinned({ x: 0, y: 0, fy: 0 })).toBe(true);
  });
});

describe("separateOnce", () => {
  it("leaves pills that already clear each other alone", () => {
    const nodes = [pill(0, 0), pill(500, 500)];
    expect(separateOnce(nodes, extentOf, 1)).toBe(false);
    expect(nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(nodes[1]).toMatchObject({ x: 500, y: 500 });
  });

  it("reports movement when a pair overlaps", () => {
    const nodes = [pill(0, 0), pill(5, 0)];
    expect(separateOnce(nodes, extentOf, 1)).toBe(true);
  });

  it("separates along the axis needing the least movement", () => {
    // Wide, short pills sitting nearly on top of each other: the cheap way out
    // is vertical, even though they also overlap horizontally.
    const nodes = [pill(0, 0, 120, 12), pill(4, 2, 120, 12)];
    separateOnce(nodes, extentOf, 1);

    expect(nodes[0].x).toBe(0);
    expect(nodes[1].x).toBe(4);
    expect(nodes[0].y!).toBeLessThan(0);
    expect(nodes[1].y!).toBeGreaterThan(2);
  });

  it("splits the correction between two free pills", () => {
    // 12 wide, 10 apart: 2 units of pill plus the 6-unit gap to recover.
    const nodes = [tall(0, 0), tall(10, 0)];
    separateOnce(nodes, extentOf, 1);

    expect(nodes[0].x!).toBeCloseTo(-4, 5);
    expect(nodes[1].x!).toBeCloseTo(14, 5);
    expect(nodes[1].x! - nodes[0].x!).toBeCloseTo(12 + PILL_GAP, 5);
  });

  it("never moves a pinned pill, and makes the free one absorb it all", () => {
    const nodes: Pill[] = [{ ...tall(0, 0), fx: 0, fy: 0 }, tall(10, 0)];
    separateOnce(nodes, extentOf, 1);

    expect(nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(nodes[1].x!).toBeCloseTo(18, 5);
  });

  it("gives up on a pair that is pinned on both sides", () => {
    const nodes: Pill[] = [
      { ...pill(0, 0), fx: 0, fy: 0 },
      { ...pill(4, 0), fx: 4, fy: 0 },
    ];
    expect(separateOnce(nodes, extentOf, 1)).toBe(false);
    expect(nodes[1]).toMatchObject({ x: 4, y: 0 });
  });

  it("corrects velocity in the same direction as position", () => {
    // A link spring pulling the two together must not simply redo the overlap
    // on the next tick.
    const nodes: Pill[] = [
      { ...tall(0, 0), vx: 5 },
      { ...tall(10, 0), vx: -5 },
    ];
    separateOnce(nodes, extentOf, 1);

    expect(nodes[0].vx!).toBeLessThan(5);
    expect(nodes[1].vx!).toBeGreaterThan(-5);
  });

  it("pulls perfectly stacked pills apart deterministically", () => {
    const nodes = [pill(0, 0), pill(0, 0)];
    separateOnce(nodes, extentOf, 1);

    expect(nodes[0].y).not.toBe(nodes[1].y);
  });

  it("scales the correction by strength", () => {
    const gentle = [tall(0, 0), tall(10, 0)];
    const firm = [tall(0, 0), tall(10, 0)];

    separateOnce(gentle, extentOf, 0.5);
    separateOnce(firm, extentOf, 1);

    expect(Math.abs(gentle[0].x!)).toBeLessThan(Math.abs(firm[0].x!));
  });
});

describe("resolveOverlaps", () => {
  it("clears a pile of pills stacked on one point", () => {
    const nodes = Array.from({ length: 12 }, () => pill(0, 0));
    resolveOverlaps(nodes, extentOf);
    expect(hasOverlap(nodes, extentOf)).toBe(false);
  });

  it("clears a dense grid of wide pills", () => {
    const nodes: Pill[] = [];
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 6; col++) {
        nodes.push(pill(col * 8, row * 4, 90, 14));
      }
    }

    resolveOverlaps(nodes, extentOf);
    expect(hasOverlap(nodes, extentOf)).toBe(false);
  });

  it("leaves at least the configured gap between an isolated pair", () => {
    const nodes = [pill(0, 0), pill(1, 0)];
    resolveOverlaps(nodes, extentOf);

    const gap = Math.abs(nodes[1].y! - nodes[0].y!) - 12;
    expect(gap).toBeGreaterThanOrEqual(PILL_GAP - 1e-9);
  });

  it("returns immediately when nothing overlaps", () => {
    const nodes = [pill(0, 0), pill(200, 0)];
    resolveOverlaps(nodes, extentOf);
    expect(nodes[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("terminates on a pile too degenerate to fully clear", () => {
    // 200 nodes on one point is far past anything a settled force layout
    // produces. The contract is that it returns, not that it succeeds.
    const nodes = Array.from({ length: 200 }, () => pill(0, 0, 80, 14));
    resolveOverlaps(nodes, extentOf);

    const spread = new Set(nodes.map((node) => `${node.x},${node.y}`));
    expect(spread.size).toBeGreaterThan(1);
  });

  it("respects pins while clearing everything it can", () => {
    const pinned: Pill = { ...pill(0, 0), fx: 0, fy: 0 };
    const nodes: Pill[] = [pinned, pill(2, 1), pill(-2, -1), pill(1, 2)];

    resolveOverlaps(nodes, extentOf);

    expect(pinned).toMatchObject({ x: 0, y: 0 });
    expect(hasOverlap(nodes, extentOf)).toBe(false);
  });
});

describe("hasOverlap", () => {
  it("needs both axes to overlap before it counts", () => {
    // Side by side: the x gap alone means they are clear.
    expect(hasOverlap([pill(0, 0), pill(60, 0)], extentOf)).toBe(false);
    // Stacked: the y gap alone means they are clear.
    expect(hasOverlap([pill(0, 0), pill(0, 20)], extentOf)).toBe(false);
    expect(hasOverlap([pill(0, 0), pill(10, 4)], extentOf)).toBe(true);
  });
});

describe("createRadialForce", () => {
  type Ringed = Positioned & { depth: number };

  function settle(nodes: Ringed[], ticks: number) {
    const force = createRadialForce<Ringed>(70);
    force.initialize(nodes);
    for (let t = 0; t < ticks; t++) {
      for (const node of nodes) {
        node.vx = node.vy = 0;
      }
      force(1);
      for (const node of nodes) {
        node.x = (node.x ?? 0) + (node.vx ?? 0);
        node.y = (node.y ?? 0) + (node.vy ?? 0);
      }
    }
  }

  it("pulls the root to the centre rather than through it", () => {
    // force-graph's own radial mode aims depth 0 at radius -70, which flings
    // the root across the origin every tick. This one must not.
    const root: Ringed = { x: 30, y: -40, depth: 0 };
    settle([root], 1);
    expect(Math.hypot(root.x ?? 0, root.y ?? 0)).toBeCloseTo(0, 6);
  });

  it("puts each depth on its own ring", () => {
    const nodes: Ringed[] = [
      { x: 5, y: 0, depth: 1 },
      { x: 0, y: 300, depth: 2 },
      { x: -10, y: -10, depth: 3 },
    ];
    settle(nodes, 1);
    for (const node of nodes) {
      expect(Math.hypot(node.x ?? 0, node.y ?? 0)).toBeCloseTo(node.depth * 70, 6);
    }
  });

  it("stays finite for a node exactly on the origin", () => {
    const node: Ringed = { x: 0, y: 0, depth: 1 };
    settle([node], 1);
    expect(Number.isFinite(node.x)).toBe(true);
    expect(Number.isFinite(node.y)).toBe(true);
  });
});

describe("large maps", () => {
  function scatter(count: number, spread: number, seed = 1): Pill[] {
    let s = seed;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
    return Array.from({ length: count }, () =>
      pill((rand() - 0.5) * spread, (rand() - 0.5) * spread, 20 + rand() * 60, 8 + rand() * 6),
    );
  }

  /** The obvious every-pair check, to hold the sweep to. */
  function bruteOverlap(nodes: Pill[]): boolean {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const gapX = Math.abs(b.x! - a.x!) - (a.w + b.w) / 2;
        const gapY = Math.abs(b.y! - a.y!) - (a.h + b.h) / 2;
        if (gapX < 0 && gapY < 0) return true;
      }
    }
    return false;
  }

  it("finds exactly the overlaps an every-pair scan finds", () => {
    for (const [count, spread] of [
      [50, 100],
      [200, 2000],
      [400, 50_000],
    ]) {
      for (let seed = 1; seed <= 5; seed++) {
        const nodes = scatter(count, spread, seed);
        expect(hasOverlap(nodes, extentOf)).toBe(bruteOverlap(nodes));
      }
    }
  });

  it("untangles 1,500 pills without stalling", () => {
    const nodes = scatter(1500, 4000);
    const started = performance.now();
    resolveOverlaps(nodes, extentOf);
    const elapsed = performance.now() - started;

    expect(bruteOverlap(nodes)).toBe(false);
    // The every-pair version took tens of seconds here; leave CI headroom.
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("createOverlapResolver", () => {
  it("does the same job as resolveOverlaps, a slice at a time", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => pill((i % 3) * 2, Math.floor(i / 3) * 2));
    let clock = 0;
    // Every check of the clock advances it, so each slice runs exactly one pass.
    const step = createOverlapResolver(nodes, extentOf, () => (clock += 1));

    let slices = 0;
    while (!step(1)) slices++;
    expect(slices).toBeGreaterThan(0);
    expect(hasOverlap(nodes, extentOf)).toBe(false);
    // Finished stays finished.
    expect(step(1)).toBe(true);
  });

  it("stops at the pass cap even if overlaps remain", () => {
    // Pinned on top of each other: nothing can ever move.
    const nodes = [
      { ...pill(0, 0), fx: 0, fy: 0 },
      { ...pill(0, 0), fx: 0, fy: 0 },
    ];
    const step = createOverlapResolver(nodes, extentOf);
    expect(step(10_000)).toBe(true);
  });
});

describe("seedRadialPositions", () => {
  const nodes = ["r", "a", "b", "a1", "a2", "a3", "b1"].map((id, i) => ({ id, depth: i === 0 ? 0 : id.length }));
  const links = [
    { source: "r", target: "a" },
    { source: "r", target: "b" },
    { source: "a", target: "a1" },
    { source: "a", target: "a2" },
    { source: "a", target: "a3" },
    { source: "b", target: "b1" },
  ];
  const at = seedRadialPositions(nodes, links, 70);
  const angle = (id: string) => Math.atan2(at.get(id)!.y, at.get(id)!.x);
  const radius = (id: string) => Math.hypot(at.get(id)!.x, at.get(id)!.y);

  it("puts the root in the middle and each level on its own ring", () => {
    expect(radius("r")).toBeCloseTo(0);
    expect(radius("a")).toBeCloseTo(70);
    expect(radius("a1")).toBeCloseTo(140);
  });

  it("keeps children inside their parent's slice of the circle", () => {
    const gap = (x: number, y: number) => {
      const d = Math.abs(x - y) % (2 * Math.PI);
      return Math.min(d, 2 * Math.PI - d);
    };
    // "a" carries three leaves to b's one, so it owns three quarters of the
    // circle; its children fan out across that, centred on it.
    expect(gap(angle("a2"), angle("a"))).toBeLessThan(1e-9);
    expect(gap(angle("a1"), angle("a"))).toBeCloseTo(Math.PI / 2);
    expect(gap(angle("a3"), angle("a"))).toBeCloseTo(Math.PI / 2);
    // A lone child sits straight out from its parent.
    expect(gap(angle("b1"), angle("b"))).toBeLessThan(1e-9);
  });

  it("gives a forest a shared first ring", () => {
    const forest = seedRadialPositions(
      [
        { id: "d1", depth: 0 },
        { id: "d2", depth: 0 },
      ],
      [],
      50,
    );
    expect(Math.hypot(forest.get("d1")!.x, forest.get("d1")!.y)).toBeCloseTo(50);
    expect(forest.get("d1")).not.toEqual(forest.get("d2"));
  });
});

describe("connectedComponents", () => {
  it("separates nodes that never reach one another", () => {
    const groups = connectedComponents(
      ["a", "b", "c", "d", "e"].map((id) => ({ id })),
      [
        { source: "a", target: "b" },
        { source: "d", target: "c" },
      ],
    );
    expect(groups).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
});

describe("packCircles", () => {
  it("never overlaps two circles", () => {
    const radii = [120, 40, 40, 300, 10, 75, 75, 75, 200, 5];
    const centres = packCircles(radii, 20);
    for (let i = 0; i < radii.length; i++) {
      for (let j = i + 1; j < radii.length; j++) {
        const d = Math.hypot(centres[i].x - centres[j].x, centres[i].y - centres[j].y);
        expect(d).toBeGreaterThanOrEqual(radii[i] + radii[j] + 20 - 1e-6);
      }
    }
  });

  it("keeps the arrangement compact", () => {
    const radii = Array.from({ length: 12 }, () => 50);
    const centres = packCircles(radii, 10);
    const reach = Math.max(...centres.map((c) => Math.hypot(c.x, c.y) + 50));
    // Twelve circles of radius 50 cover ~94k units²; a loose spiral would sprawl far past that.
    expect(reach).toBeLessThan(260);
  });
});

describe("layoutGroups", () => {
  const tree = (prefix: string, kids: number) => ({
    nodes: [
      { id: `${prefix}`, depth: 0 },
      ...Array.from({ length: kids }, (_, i) => ({ id: `${prefix}${i}`, depth: 1 })),
    ],
    links: Array.from({ length: kids }, (_, i) => ({ source: prefix, target: `${prefix}${i}` })),
  });

  it("keeps a single tree around the origin", () => {
    const { nodes, links } = tree("r", 4);
    const places = layoutGroups(nodes, links, 70);
    expect(places.get("r")).toMatchObject({ x: 0, y: 0, centreX: 0, centreY: 0, ring: 0 });
    expect(places.get("r0")!.ring).toBe(1);
  });

  it("gives unrelated trees their own space", () => {
    const a = tree("a", 6);
    const b = tree("b", 3);
    const places = layoutGroups([...a.nodes, ...b.nodes], [...a.links, ...b.links], 70, 60);
    const centre = (id: string) => ({ x: places.get(id)!.centreX, y: places.get(id)!.centreY });
    expect(centre("a")).not.toEqual(centre("b"));

    // Every node of one tree is further from the other tree's centre than that
    // tree's own reach: the groups' circles do not meet.
    const reach = (prefix: string, nodes: { id: string }[]) =>
      Math.max(...nodes.map((n) => Math.hypot(places.get(n.id)!.x - centre(prefix).x, places.get(n.id)!.y - centre(prefix).y)));
    const reachB = reach("b", b.nodes);
    for (const node of a.nodes) {
      const p = places.get(node.id)!;
      expect(Math.hypot(p.x - centre("b").x, p.y - centre("b").y)).toBeGreaterThan(reachB);
    }
  });
});

describe("fitBoosts", () => {
  const item = (id: string, x: number, want: number, priority = 0) => ({
    id,
    x,
    y: 0,
    halfWidth: 10,
    halfHeight: 4,
    want,
    priority,
  });

  it("keeps the full enlargement where there is room", () => {
    expect(fitBoosts([item("a", 0, 3), item("b", 500, 3)], 2).get("a")).toBe(3);
  });

  it("shrinks colliding enlargements, the lower priority first", () => {
    const boosts = fitBoosts([item("low", 0, 3, 1), item("high", 45, 3, 5)], 2);
    expect(boosts.get("high")).toBe(3);
    expect(boosts.get("low")!).toBeLessThan(3);
    // What is left fits: the two boxes no longer meet.
    const gapX = 45 - 10 * boosts.get("high")! - 10 * boosts.get("low")!;
    expect(gapX >= 2 || boosts.get("low") === 1).toBe(true);
  });

  it("grows only into the room a fixed label leaves", () => {
    // 25 apart: "big" clears "fixed" up to 10·b + 10 + 2 < 25, so b < 1.3.
    const boosts = fitBoosts([item("fixed", 25, 1), item("big", 0, 4)], 2);
    expect(boosts.get("fixed")).toBe(1);
    expect(boosts.get("big")!).toBeGreaterThan(1);
    expect(boosts.get("big")!).toBeLessThan(1.3);
  });

  it("never shrinks below natural size", () => {
    const boosts = fitBoosts([item("fixed", 5, 1), item("big", 0, 4)], 2);
    expect(boosts.get("big")).toBe(1);
  });
});
