import { describe, expect, it } from "vitest";
import { buildMindmap } from "@/lib/mindmap";

describe("buildMindmap", () => {
  it("uses the document title as the root", () => {
    expect(buildMindmap("My Note", "")).toEqual({
      id: "root",
      label: "My Note",
      children: [],
    });
  });

  it("ignores non-heading lines", () => {
    const tree = buildMindmap("T", "plain prose\n\nmore prose\n");
    expect(tree.children).toEqual([]);
  });

  it("nests headings by level", () => {
    const tree = buildMindmap("T", "# One\n## One A\n## One B\n# Two\n");
    expect(tree.children.map((c) => c.label)).toEqual(["One", "Two"]);
    expect(tree.children[0].children.map((c) => c.label)).toEqual([
      "One A",
      "One B",
    ]);
    expect(tree.children[1].children).toEqual([]);
  });

  it("nests three levels deep", () => {
    const tree = buildMindmap("T", "# A\n## B\n### C\n");
    expect(tree.children[0].children[0].children[0].label).toBe("C");
  });

  it("pops back out to a shallower level", () => {
    const tree = buildMindmap("T", "# A\n### Deep\n## B\n");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].children.map((c) => c.label)).toEqual(["Deep", "B"]);
  });

  it("treats a skipped level as a direct child", () => {
    const tree = buildMindmap("T", "# A\n### Skipped\n");
    expect(tree.children[0].children.map((c) => c.label)).toEqual(["Skipped"]);
  });

  it("handles a document that starts at ##", () => {
    const tree = buildMindmap("T", "## A\n## B\n");
    expect(tree.children.map((c) => c.label)).toEqual(["A", "B"]);
  });

  it("strips wikilink syntax from labels", () => {
    const tree = buildMindmap("T", "# [[Auth]] flow\n");
    expect(tree.children[0].label).toBe("Auth flow");
  });

  it("prefers the alias when a heading link has one", () => {
    const tree = buildMindmap("T", "# [[Auth|Sign in]]\n");
    expect(tree.children[0].label).toBe("Sign in");
  });

  it("strips closing ATX hashes", () => {
    const tree = buildMindmap("T", "# Heading #\n");
    expect(tree.children[0].label).toBe("Heading");
  });

  it("skips headings with no text", () => {
    const tree = buildMindmap("T", "#\n#   \n# Real\n");
    expect(tree.children.map((c) => c.label)).toEqual(["Real"]);
  });

  it("does not treat a hash without a space as a heading", () => {
    const tree = buildMindmap("T", "#nothashtag\n");
    expect(tree.children).toEqual([]);
  });

  it("assigns unique ids to every node", () => {
    const tree = buildMindmap("T", "# A\n## A\n# A\n");
    const ids: string[] = [];
    const walk = (n: { id: string; children: { id: string }[] }) => {
      ids.push(n.id);
      n.children.forEach((c) => walk(c as never));
    };
    walk(tree);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ignores levels deeper than h6", () => {
    const tree = buildMindmap("T", "####### TooDeep\n");
    expect(tree.children).toEqual([]);
  });
});
