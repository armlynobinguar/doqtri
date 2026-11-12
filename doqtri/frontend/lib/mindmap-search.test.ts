import { describe, expect, it } from "vitest";
import type { MapNode } from "@/lib/mindmap-graph";
import { searchNodes } from "@/lib/mindmap-search";

const node = (id: string, label: string, depth = 1): MapNode => ({ id, label, kind: "concept", depth });

describe("searchNodes", () => {
  const nodes = [
    node("a", "Launch plan", 2),
    node("b", "Pre-launch checklist", 1),
    node("c", "LAUNCH", 3),
    node("d", "Budget", 1),
    node("e", "launch   day", 1),
  ];

  it("matches case- and space-insensitively, labels starting with the query first", () => {
    expect(searchNodes(nodes, "  launch ").map((n) => n.id)).toEqual(["e", "a", "c", "b"]);
    expect(searchNodes(nodes, "launch day").map((n) => n.id)).toEqual(["e"]);
  });

  it("finds nothing for a blank query or no match", () => {
    expect(searchNodes(nodes, "   ")).toEqual([]);
    expect(searchNodes(nodes, "zzz")).toEqual([]);
  });

  it("lists at most the limit, on a 5000-node map", () => {
    const big = Array.from({ length: 5000 }, (_, i) => node(`n${i}`, `Concept ${i}`, 1 + (i % 4)));
    const hits = searchNodes(big, "concept 4");
    expect(hits).toHaveLength(8);
    expect(hits[0].label).toBe("Concept 4");
  });
});
