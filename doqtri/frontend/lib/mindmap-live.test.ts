import { describe, expect, it } from "vitest";
import { graphFromMindmap } from "@/lib/mindmap-graph";
import { mindmapFromHeadings } from "@/lib/mindmap-types";
import { carryLayout, LIVE_ROOT_ID, withLabelPathIds, type PlacedNode } from "@/lib/mindmap-live";

const live = (markdown: string) => graphFromMindmap(withLabelPathIds(mindmapFromHeadings("Plan", markdown)));

describe("withLabelPathIds", () => {
  it("names nodes by their heading path, not their position", () => {
    const before = live("## Goals\n### Ship\n## Risks\n");
    const after = live("## Intro\n## Goals\n### Ship\n## Risks\n");
    expect(before.nodes.map((n) => n.id)).toEqual([LIVE_ROOT_ID, "goals", "goals\nship", "risks"]);
    // A heading inserted above leaves every other id alone.
    expect(after.nodes.map((n) => n.id)).toEqual([LIVE_ROOT_ID, "intro", "goals", "goals\nship", "risks"]);
  });

  it("ignores case and spacing, and numbers repeated siblings", () => {
    const graph = live("## Notes\n## notes \n## Other\n### Notes\n");
    expect(graph.nodes.map((n) => n.id)).toEqual([LIVE_ROOT_ID, "notes", "notes#2", "other", "other\nnotes"]);
  });

  it("keeps the root id when the note is renamed", () => {
    const renamed = graphFromMindmap(withLabelPathIds(mindmapFromHeadings("Renamed", "## Goals\n")));
    expect(renamed.nodes[0].id).toBe(LIVE_ROOT_ID);
  });
});

describe("carryLayout", () => {
  const fallback = new Map([
    ["root", { x: 0, y: 0 }],
    ["intro", { x: 0, y: -70 }],
    ["goals", { x: 70, y: 0 }],
    ["goals\nship", { x: 140, y: 0 }],
    ["risks", { x: -70, y: 0 }],
  ]);

  function previousOf(markdown: string): Map<string, PlacedNode> {
    // Somewhere the old layout settled: not where a fresh layout would start.
    return new Map(live(markdown).nodes.map((node, i) => [node.id, { x: 10 + i * 31, y: -5 - i * 17 }]));
  }

  it("keeps every existing node where it was when a heading is added above", () => {
    const previous = previousOf("## Goals\n### Ship\n## Risks\n");
    const next = live("## Intro\n## Goals\n### Ship\n## Risks\n");
    const carried = carryLayout(previous, next.nodes, next.links, fallback, { instant: false, ringDistance: 70 })!;

    for (const [id, at] of previous) {
      expect(carried.get(id), id).toMatchObject({ x: at.x, y: at.y, fx: at.x, fy: at.y, fresh: false });
    }
    expect(carried.get("intro")?.fresh).toBe(true);
  });

  it("keeps them when a heading is added below too", () => {
    const previous = previousOf("## Goals\n## Risks\n");
    const next = live("## Goals\n## Risks\n## Later\n");
    const carried = carryLayout(previous, next.nodes, next.links, fallback, { instant: false, ringDistance: 70 })!;
    expect(carried.get("goals")).toMatchObject({ ...previous.get("goals"), fresh: false });
    expect(carried.get("risks")).toMatchObject({ ...previous.get("risks"), fresh: false });
    expect(carried.get("later")?.fresh).toBe(true);
  });

  it("starts a new node a short way out of its parent, facing away from the centre", () => {
    const previous = new Map<string, PlacedNode>([
      ["root", { x: 0, y: 0 }],
      ["goals", { x: 70, y: 0 }],
    ]);
    const next = live("## Goals\n### Ship\n");
    const carried = carryLayout(previous, next.nodes, next.links, fallback, { instant: false, ringDistance: 70 })!;
    const child = carried.get("goals\nship")!;
    // Out along the parent's ray, well short of the next ring: it grows from there.
    expect(child.y).toBeCloseTo(0, 5);
    expect(child.x).toBeGreaterThan(70 + 10);
    expect(child.x).toBeLessThan(140);
    expect(child.fx).toBeUndefined();
    expect(child.fresh).toBe(true);
  });

  it("places a new node a ring out, with nothing to animate, when motion is reduced", () => {
    const previous = new Map<string, PlacedNode>([
      ["root", { x: 0, y: 0 }],
      ["goals", { x: 70, y: 0 }],
    ]);
    const next = live("## Goals\n### Ship\n");
    const carried = carryLayout(previous, next.nodes, next.links, fallback, { instant: true, ringDistance: 70 })!;
    expect(carried.get("goals\nship")!.x).toBeCloseTo(140, 5);
    expect(carried.get("goals\nship")!.y).toBeCloseTo(0, 5);
  });

  it("keeps a node the user pinned by hand at its pin", () => {
    const previous = new Map<string, PlacedNode>([
      ["root", { x: 0, y: 0 }],
      ["goals", { x: 5, y: 5, fx: 40, fy: 40 }],
    ]);
    const next = live("## Goals\n");
    const carried = carryLayout(previous, next.nodes, next.links, fallback, { instant: false, ringDistance: 70 })!;
    expect(carried.get("goals")).toMatchObject({ fx: 40, fy: 40 });
  });

  it("is null for a map that shares nothing with the last one", () => {
    const next = live("## Goals\n");
    const previous = new Map<string, PlacedNode>([["elsewhere", { x: 1, y: 1 }]]);
    expect(carryLayout(previous, next.nodes, next.links, fallback, { instant: false, ringDistance: 70 })).toBeNull();
    expect(carryLayout(new Map(), next.nodes, next.links, fallback, { instant: false, ringDistance: 70 })).toBeNull();
  });
});
