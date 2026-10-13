import { describe, expect, it } from "vitest";
import {
  buildBacklinks,
  buildGraph,
  completeLink,
  findLinkQuery,
  matchIndices,
  parseLinks,
  rankLinkSuggestions,
} from "@/lib/wikilinks";
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

/** Caret position marked with `¦` in the fixture; returns [text, caret]. */
const at = (marked: string): [string, number] => {
  const caret = marked.indexOf("¦");
  return [marked.replace("¦", ""), caret];
};

describe("findLinkQuery", () => {
  it("opens on [[ with an empty query", () => {
    expect(findLinkQuery(...at("see [[¦"))).toEqual({ start: 6, query: "" });
  });

  it("captures what has been typed after [[", () => {
    expect(findLinkQuery(...at("see [[Meet¦"))).toEqual({ start: 6, query: "Meet" });
  });

  it("works with the caret inside an already closed link", () => {
    expect(findLinkQuery(...at("[[Al¦pha]]"))).toEqual({ start: 2, query: "Al" });
  });

  it("is null outside a link", () => {
    expect(findLinkQuery(...at("plain ¦text"))).toBeNull();
    expect(findLinkQuery(...at("[[Alpha]] after¦"))).toBeNull();
    expect(findLinkQuery(...at("[single¦"))).toBeNull();
  });

  it("does not reach across a newline", () => {
    expect(findLinkQuery(...at("[[Alpha\nnext¦"))).toBeNull();
  });

  it("stops once an alias starts", () => {
    expect(findLinkQuery(...at("[[Alpha|the¦"))).toBeNull();
  });

  it("ignores triple brackets", () => {
    expect(findLinkQuery(...at("[[[x¦"))).toBeNull();
  });
});

describe("rankLinkSuggestions", () => {
  const titles = ["Meeting notes", "Roadmap", "Team meeting", "Memo", "Atom"];

  it("lists everything alphabetically for an empty query", () => {
    expect(rankLinkSuggestions(titles, "")).toEqual([
      "Atom",
      "Meeting notes",
      "Memo",
      "Roadmap",
      "Team meeting",
    ]);
  });

  it("ranks prefix over word-start over substring over subsequence", () => {
    expect(rankLinkSuggestions(["xmeet", "Team meeting", "Meeting notes", "m-e-e-t"], "meet")).toEqual([
      "Meeting notes",
      "Team meeting",
      "xmeet",
      "m-e-e-t",
    ]);
  });

  it("puts an exact match first and is case-insensitive", () => {
    expect(rankLinkSuggestions(["Memo pad", "memo"], "MEMO")).toEqual(["memo", "Memo pad"]);
  });

  it("drops non-matches and duplicate titles", () => {
    expect(rankLinkSuggestions(["Alpha", "alpha", "Beta"], "al")).toEqual(["Alpha"]);
  });

  it("respects the limit", () => {
    expect(rankLinkSuggestions(titles, "", 2)).toEqual(["Atom", "Meeting notes"]);
  });
});

describe("completeLink", () => {
  const apply = (marked: string, title: string) => {
    const [text, caret] = at(marked);
    const link = findLinkQuery(text, caret)!;
    const edit = completeLink(text, caret, link, title);
    const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    return next.slice(0, edit.caret) + "¦" + next.slice(edit.caret);
  };

  it("closes a fresh link and lands after ]]", () => {
    expect(apply("see [[Me¦ later", "Meeting notes")).toBe("see [[Meeting notes]]¦ later");
  });

  it("replaces the old target inside a closed link without doubling ]]", () => {
    expect(apply("[[Al¦pha]] x", "Atom")).toBe("[[Atom]]¦ x");
  });

  it("keeps an existing alias and lands before it", () => {
    expect(apply("[[Al¦pha|first]]", "Atom")).toBe("[[Atom¦|first]]");
  });
});

describe("matchIndices", () => {
  it("marks a contiguous match", () => {
    expect(matchIndices("Team meeting", "meet")).toEqual([5, 6, 7, 8]);
  });

  it("falls back to subsequence characters", () => {
    expect(matchIndices("Meeting notes", "mtg")).toEqual([0, 3, 6]);
  });

  it("is empty for an empty query", () => {
    expect(matchIndices("Alpha", "")).toEqual([]);
  });
});
