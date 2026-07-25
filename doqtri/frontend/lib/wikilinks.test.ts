import { describe, expect, it } from "vitest";
import { buildBacklinks, buildGraph, parseLinks } from "@/lib/wikilinks";
import type { Doc } from "@/lib/types";

const doc = (id: string, title: string, markdown = ""): Doc => ({
  id,
  title,
  markdown,
});

describe("parseLinks", () => {
  it("captures plain targets", () => {
    expect(parseLinks("see [[Alpha]] and [[Beta]]")).toEqual(["Alpha", "Beta"]);
  });

  it("captures the target of an aliased link, not the alias", () => {
    expect(parseLinks("[[Alpha|the first one]]")).toEqual(["Alpha"]);
  });

  it("trims whitespace inside the brackets", () => {
    expect(parseLinks("[[  Alpha  ]]")).toEqual(["Alpha"]);
  });

  it("preserves duplicates and document order", () => {
    expect(parseLinks("[[B]] [[A]] [[B]]")).toEqual(["B", "A", "B"]);
  });

  it("ignores empty and malformed brackets", () => {
    expect(parseLinks("[[]] [[   ]] [[unclosed [single] text")).toEqual([]);
  });

  it("returns nothing for markdown with no links", () => {
    expect(parseLinks("# Heading\n\nplain prose")).toEqual([]);
  });

  it("is pure across repeated calls (no leaked regex state)", () => {
    const markdown = "[[Alpha]] [[Beta]]";
    expect(parseLinks(markdown)).toEqual(parseLinks(markdown));
  });

  it("handles multiline markdown", () => {
    expect(parseLinks("# A\ntext [[One]]\n\n## B\n[[Two]]\n")).toEqual([
      "One",
      "Two",
    ]);
  });
});

describe("buildGraph", () => {
  it("returns an empty graph for no docs", () => {
    expect(buildGraph([])).toEqual({ nodes: [], edges: [] });
  });

  it("creates one non-ghost node per document", () => {
    const graph = buildGraph([doc("1", "Alpha"), doc("2", "Beta")]);
    expect(graph.nodes).toEqual([
      { id: "1", label: "Alpha", ghost: false },
      { id: "2", label: "Beta", ghost: false },
    ]);
    expect(graph.edges).toEqual([]);
  });

  it("resolves a link to an existing document by title", () => {
    const graph = buildGraph([doc("1", "Alpha", "[[Beta]]"), doc("2", "Beta")]);
    expect(graph.edges).toEqual([{ source: "1", target: "2" }]);
    expect(graph.nodes.filter((n) => n.ghost)).toEqual([]);
  });

  it("matches titles case- and trim-insensitively", () => {
    const graph = buildGraph([
      doc("1", "Alpha", "[[  bEtA  ]]"),
      doc("2", "  Beta "),
    ]);
    expect(graph.edges).toEqual([{ source: "1", target: "2" }]);
    expect(graph.nodes.filter((n) => n.ghost)).toEqual([]);
  });

  it("creates a ghost node for an unresolved target", () => {
    const graph = buildGraph([doc("1", "Alpha", "[[Missing]]")]);
    expect(graph.nodes).toEqual([
      { id: "1", label: "Alpha", ghost: false },
      { id: "missing", label: "Missing", ghost: true },
    ]);
    expect(graph.edges).toEqual([{ source: "1", target: "missing" }]);
  });

  it("creates a ghost node only once across documents and casings", () => {
    const graph = buildGraph([
      doc("1", "Alpha", "[[Missing]]"),
      doc("2", "Beta", "[[ missing ]]"),
    ]);
    const ghosts = graph.nodes.filter((n) => n.ghost);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].id).toBe("missing");
    expect(graph.edges).toEqual([
      { source: "1", target: "missing" },
      { source: "2", target: "missing" },
    ]);
  });

  it("de-duplicates repeated links between the same pair", () => {
    const graph = buildGraph([
      doc("1", "Alpha", "[[Beta]] again [[Beta]] and [[ beta ]]"),
      doc("2", "Beta"),
    ]);
    expect(graph.edges).toEqual([{ source: "1", target: "2" }]);
  });

  it("keeps both directions of a mutual link", () => {
    const graph = buildGraph([
      doc("1", "Alpha", "[[Beta]]"),
      doc("2", "Beta", "[[Alpha]]"),
    ]);
    expect(graph.edges).toEqual([
      { source: "1", target: "2" },
      { source: "2", target: "1" },
    ]);
  });

  it("uses the target text for the ghost label but the normalized title for its id", () => {
    const graph = buildGraph([doc("1", "Alpha", "[[Some Concept]]")]);
    const ghost = graph.nodes.find((n) => n.ghost);
    expect(ghost).toEqual({
      id: "some concept",
      label: "Some Concept",
      ghost: true,
    });
  });

  it("resolves a link written as an alias to the real note", () => {
    const graph = buildGraph([
      doc("1", "Alpha", "[[Beta|see beta]]"),
      doc("2", "Beta"),
    ]);
    expect(graph.edges).toEqual([{ source: "1", target: "2" }]);
  });
});

describe("buildBacklinks", () => {
  it("finds documents linking to the target", () => {
    const docs = [
      doc("1", "Alpha", "[[Target]]"),
      doc("2", "Beta", "no links"),
      doc("3", "Target"),
      doc("4", "Gamma", "[[ target ]]"),
    ];
    expect(buildBacklinks(docs, "3").map((d) => d.id)).toEqual(["1", "4"]);
  });

  it("excludes the document itself", () => {
    const docs = [doc("1", "Alpha", "[[Alpha]]")];
    expect(buildBacklinks(docs, "1")).toEqual([]);
  });

  it("returns nothing for an unknown id", () => {
    expect(buildBacklinks([doc("1", "Alpha")], "nope")).toEqual([]);
  });
});
