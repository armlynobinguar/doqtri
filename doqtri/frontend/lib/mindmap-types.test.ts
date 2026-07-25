import { describe, expect, it } from "vitest";
import {
  flattenConcepts,
  mindmapFromHeadings,
  normalizeConcept,
  parseDocMindmap,
  toDocMindmap,
  type ConceptNode,
  type RawConceptNode,
} from "@/lib/mindmap-types";

function raw(label: string, children: RawConceptNode[] = []): RawConceptNode {
  return { label, children };
}

function labels(nodes: ConceptNode[]): string[] {
  return nodes.map((node) => node.label);
}

describe("normalizeConcept", () => {
  it("folds case and collapses whitespace", () => {
    expect(normalizeConcept("  Zero  Knowledge   Proof ")).toBe(
      "zero knowledge proof",
    );
  });
});

describe("toDocMindmap", () => {
  it("forces the stored title as the root label", () => {
    const map = toDocMindmap("Real Title", raw("Model's Own Title", [raw("A")]));
    expect(map.root.label).toBe("Real Title");
  });

  it("assigns kinds by depth", () => {
    const map = toDocMindmap("T", raw("T", [raw("Theme", [raw("Concept", [raw("Detail")])])]));
    const theme = map.root.children[0];
    const concept = theme.children[0];
    const detail = concept.children[0];

    expect([map.root.kind, theme.kind, concept.kind, detail.kind]).toEqual([
      "root",
      "theme",
      "concept",
      "detail",
    ]);
  });

  it("drops levels past the depth cap", () => {
    const map = toDocMindmap(
      "T",
      raw("T", [raw("L1", [raw("L2", [raw("L3", [raw("L4")])])])]),
    );
    const l3 = map.root.children[0].children[0].children[0];
    expect(l3.label).toBe("L3");
    expect(l3.children).toEqual([]);
  });

  it("clamps breadth to the child cap", () => {
    const many = Array.from({ length: 12 }, (_, i) => raw(`C${i}`));
    const map = toDocMindmap("T", raw("T", many));
    expect(map.root.children).toHaveLength(7);
  });

  it("drops blank labels", () => {
    const map = toDocMindmap("T", raw("T", [raw("  "), raw("Kept")]));
    expect(labels(map.root.children)).toEqual(["Kept"]);
  });

  it("keeps a summary only when it has content", () => {
    const map = toDocMindmap("T", {
      label: "T",
      children: [
        { label: "A", summary: "  " },
        { label: "B", summary: " says something " },
      ],
    });
    expect(map.root.children[0].summary).toBeUndefined();
    expect(map.root.children[1].summary).toBe("says something");
  });

  it("assigns unique ids even when labels repeat", () => {
    const map = toDocMindmap("T", raw("T", [raw("A", [raw("A")]), raw("A")]));
    const ids: string[] = [];
    const walk = (node: ConceptNode) => {
      ids.push(node.id);
      node.children.forEach(walk);
    };
    walk(map.root);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("collects concepts without the root and without duplicates", () => {
    const map = toDocMindmap("T", raw("T", [raw("Auth", [raw("auth"), raw("Tokens")])]));
    expect(map.concepts).toEqual(["Auth", "Tokens"]);
  });
});

describe("flattenConcepts", () => {
  it("excludes the root", () => {
    const map = toDocMindmap("Root Label", raw("Root Label", [raw("Child")]));
    expect(flattenConcepts(map.root)).toEqual(["Child"]);
  });
});

describe("parseDocMindmap", () => {
  const valid = toDocMindmap("T", raw("T", [raw("A", [raw("B")])]));

  it("round-trips a valid map through JSON", () => {
    expect(parseDocMindmap(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it("rejects non-objects", () => {
    expect(parseDocMindmap(null)).toBeNull();
    expect(parseDocMindmap("nope")).toBeNull();
    expect(parseDocMindmap(42)).toBeNull();
  });

  it("rejects an unknown version", () => {
    expect(parseDocMindmap({ ...valid, version: 2 })).toBeNull();
  });

  it("rejects a map with no usable root", () => {
    expect(parseDocMindmap({ version: 1, root: { id: "root" }, concepts: [] })).toBeNull();
    expect(
      parseDocMindmap({ version: 1, root: { id: "root", label: "  " }, concepts: [] }),
    ).toBeNull();
  });

  it("drops malformed children instead of failing the whole map", () => {
    const parsed = parseDocMindmap({
      version: 1,
      root: {
        id: "root",
        label: "T",
        children: [{ id: "c0", label: "Good", children: [] }, { id: "c1" }, null],
      },
      concepts: [],
    });
    expect(labels(parsed!.root.children)).toEqual(["Good"]);
  });

  it("recomputes concepts when the stored list is missing", () => {
    const parsed = parseDocMindmap({
      version: 1,
      root: { id: "root", label: "T", children: [{ id: "c0", label: "A", children: [] }] },
    });
    expect(parsed!.concepts).toEqual(["A"]);
  });

  it("ignores non-string entries in the concept list", () => {
    const parsed = parseDocMindmap({ ...valid, concepts: ["A", 7, null] });
    expect(parsed!.concepts).toEqual(["A"]);
  });
});

describe("mindmapFromHeadings", () => {
  it("shapes the heading tree as a concept map", () => {
    const map = mindmapFromHeadings("Doc", "# One\n## One A\n# Two\n");
    expect(map.root.label).toBe("Doc");
    expect(map.root.kind).toBe("root");
    expect(labels(map.root.children)).toEqual(["One", "Two"]);
    expect(map.root.children[0].kind).toBe("theme");
    expect(labels(map.root.children[0].children)).toEqual(["One A"]);
    expect(map.concepts).toEqual(["One", "One A", "Two"]);
  });

  it("is empty for a document with no headings", () => {
    expect(mindmapFromHeadings("Doc", "just prose\n").root.children).toEqual([]);
  });
});
