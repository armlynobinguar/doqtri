import { describe, expect, it } from "vitest";
import { buildGlobalMindmap } from "@/lib/global-mindmap";
import { toDocMindmap, type RawConceptNode } from "@/lib/mindmap-types";
import type { MapNode } from "@/lib/mindmap-graph";
import type { Doc } from "@/lib/types";

function raw(label: string, children: RawConceptNode[] = []): RawConceptNode {
  return { label, children };
}

/** A doc with a stored mindmap whose themes are the given labels. */
function doc(id: string, title: string, themes: string[][]): Doc {
  return {
    id,
    title,
    markdown: `# ${title}\n`,
    mindmap: toDocMindmap(
      title,
      raw(
        title,
        themes.map(([theme, ...rest]) => raw(theme, rest.map((r) => raw(r)))),
      ),
    ),
  };
}

function byId(nodes: MapNode[]): Map<string, MapNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function edges(graph: { links: { source: string; target: string }[] }): string[] {
  return graph.links.map((link) => `${link.source} -> ${link.target}`);
}

describe("buildGlobalMindmap", () => {
  it("is empty for an empty vault", () => {
    expect(buildGlobalMindmap([])).toEqual({ nodes: [], links: [] });
  });

  it("gives a single document its own concept map", () => {
    const graph = buildGlobalMindmap([doc("d1", "Alpha", [["Themes", "Leaf"]])]);
    const nodes = byId(graph.nodes);

    expect(nodes.get("doc:d1")).toMatchObject({
      label: "Alpha",
      kind: "document",
      href: "/vault/d1/mindmap",
    });
    expect(nodes.get("concept:themes")?.kind).toBe("concept");
    expect(edges(graph)).toEqual([
      "doc:d1 -> concept:themes",
      "concept:themes -> concept:leaf",
    ]);
  });

  it("merges the same concept across documents into one node", () => {
    const graph = buildGlobalMindmap([
      doc("d1", "Alpha", [["Shared Idea"]]),
      doc("d2", "Beta", [["shared   idea"]]),
    ]);

    const shared = graph.nodes.filter((node) => node.id === "concept:shared idea");
    expect(shared).toHaveLength(1);
    expect(edges(graph)).toEqual([
      "doc:d1 -> concept:shared idea",
      "doc:d2 -> concept:shared idea",
    ]);
  });

  it("promotes a concept reached by two documents to a hub", () => {
    const graph = buildGlobalMindmap([
      doc("d1", "Alpha", [["Shared"], ["Only Mine"]]),
      doc("d2", "Beta", [["Shared"]]),
    ]);
    const nodes = byId(graph.nodes);

    expect(nodes.get("concept:shared")?.kind).toBe("hub");
    expect(nodes.get("concept:only mine")?.kind).toBe("concept");
  });

  it("does not promote a concept one document repeats", () => {
    const graph = buildGlobalMindmap([doc("d1", "Alpha", [["Twice"], ["Twice"]])]);
    expect(byId(graph.nodes).get("concept:twice")?.kind).toBe("concept");
  });

  it("resolves a concept named after another note to that note", () => {
    const graph = buildGlobalMindmap([
      doc("d1", "Alpha", [["Beta"]]),
      doc("d2", "Beta", [["Leaf"]]),
    ]);

    expect(graph.nodes.some((node) => node.id === "concept:beta")).toBe(false);
    expect(edges(graph)).toContain("doc:d1 -> doc:d2");
  });

  it("skips a concept named after its own note without losing its children", () => {
    const graph = buildGlobalMindmap([doc("d1", "Alpha", [["Alpha", "Kept"]])]);

    expect(graph.nodes.some((node) => node.id === "concept:alpha")).toBe(false);
    expect(edges(graph)).toEqual(["doc:d1 -> concept:kept"]);
  });

  it("keeps the shallowest depth when documents disagree", () => {
    const shallow = doc("d1", "Alpha", [["Topic"]]);
    const deep = doc("d2", "Beta", [["Wrapper", "Topic"]]);
    const nodes = byId(buildGlobalMindmap([deep, shallow]).nodes);

    expect(nodes.get("concept:topic")?.depth).toBe(1);
  });

  it("falls back to the heading tree when a note has no stored mindmap", () => {
    const graph = buildGlobalMindmap([
      {
        id: "d1",
        title: "Alpha",
        markdown: "# Section One\n## Nested\n",
        mindmap: null,
      },
    ]);

    expect(edges(graph)).toEqual([
      "doc:d1 -> concept:section one",
      "concept:section one -> concept:nested",
    ]);
  });

  it("falls back to wikilinks when a note has neither a mindmap nor headings", () => {
    const graph = buildGlobalMindmap([
      {
        id: "d1",
        title: "Alpha",
        markdown: "Prose about [[Cryptography]] and [[cryptography]] and [[Proofs]].",
        mindmap: null,
      },
    ]);

    expect(edges(graph)).toEqual([
      "doc:d1 -> concept:cryptography",
      "doc:d1 -> concept:proofs",
    ]);
  });

  it("never emits a duplicate edge", () => {
    const graph = buildGlobalMindmap([
      doc("d1", "Alpha", [["Shared"], ["Shared"]]),
      doc("d2", "Beta", [["Shared"]]),
    ]);
    expect(new Set(edges(graph)).size).toBe(graph.links.length);
  });

  it("carries a concept summary over from whichever note has one", () => {
    const withSummary: Doc = {
      id: "d1",
      title: "Alpha",
      markdown: "# Alpha\n",
      mindmap: toDocMindmap("Alpha", {
        label: "Alpha",
        children: [{ label: "Topic", summary: "what it means" }],
      }),
    };
    const withoutSummary = doc("d2", "Beta", [["Topic"]]);

    // Order matters: the bare mention comes first, so the summary has to be
    // filled in on the second pass rather than only set at creation.
    const nodes = byId(buildGlobalMindmap([withoutSummary, withSummary]).nodes);
    expect(nodes.get("concept:topic")?.summary).toBe("what it means");
  });
});
