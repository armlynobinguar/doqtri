import { describe, expect, it } from "vitest";
import {
  PILL_GAP,
  hasOverlap,
  isPinned,
  resolveOverlaps,
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
