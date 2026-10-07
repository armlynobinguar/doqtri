import { describe, expect, it } from "vitest";
import {
  applyPreset,
  assignBranches,
  decodeStyle,
  DEFAULT_STYLE,
  encodeStyle,
  isHexColor,
  isLight,
  mix,
  parseStyle,
  PRESETS,
  randomStyle,
  resolveLook,
  displayLabel,
  particlesPerLink,
} from "@/lib/mindmap-style";
import { createFocusIndex, overviewGraph, revealAlpha, type MindmapGraph } from "@/lib/mindmap-graph";

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe("colour helpers", () => {
  it("mixes hex colours", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#fff", "#000", 0)).toBe("#ffffff");
  });

  it("tells light from dark", () => {
    expect(isLight("#f5f0e6")).toBe(true);
    expect(isLight("#08090b")).toBe(false);
  });
});

describe("parseStyle", () => {
  it("returns the defaults for garbage", () => {
    expect(parseStyle(null)).toEqual(DEFAULT_STYLE);
    expect(parseStyle("nope")).toEqual(DEFAULT_STYLE);
    expect(parseStyle([1, 2])).toEqual(DEFAULT_STYLE);
  });

  it("keeps valid fields and replaces invalid ones one by one", () => {
    const parsed = parseStyle({
      shape: "hexagon",
      font: "comic-sans",
      glow: 9,
      textScale: -4,
      link: { particles: 2.6, curvature: "a lot" },
      palette: { background: "#123456", link: "red", branches: ["#ff0000", 4, "#00ff00"] },
    });
    expect(parsed.shape).toBe("hexagon");
    expect(parsed.font).toBe(DEFAULT_STYLE.font);
    expect(parsed.glow).toBe(1);
    expect(parsed.textScale).toBe(0.6);
    expect(parsed.link.particles).toBe(3);
    expect(parsed.link.curvature).toBe(DEFAULT_STYLE.link.curvature);
    expect(parsed.palette.background).toBe("#123456");
    expect(parsed.palette.link).toBe(DEFAULT_STYLE.palette.link);
    expect(parsed.palette.branches).toEqual(["#ff0000", "#00ff00"]);
  });

  it("cleans node overrides", () => {
    const parsed = parseStyle({
      overrides: {
        a: { color: "#abcdef", emoji: "  🔥  ", scale: 10, hidden: true },
        b: { color: "javascript:alert(1)" },
        c: "not an object",
      },
    });
    expect(parsed.overrides).toEqual({ a: { color: "#abcdef", emoji: "🔥", scale: 3, hidden: true } });
  });

  it("round-trips every preset unchanged", () => {
    for (const preset of PRESETS) {
      const style = applyPreset(DEFAULT_STYLE, preset.id);
      expect(parseStyle(JSON.parse(JSON.stringify(style)))).toEqual(style);
    }
  });

  it("only produces valid colours in presets", () => {
    for (const preset of PRESETS) {
      const { palette } = applyPreset(DEFAULT_STYLE, preset.id);
      const colors = [
        palette.background,
        palette.backgroundAlt,
        palette.link,
        palette.depthFrom,
        palette.depthTo,
        ...palette.branches,
        ...Object.values(palette.kinds).flatMap((k) => [k.fill, k.stroke, k.text]),
      ];
      for (const value of colors) expect(isHexColor(value), `${preset.id}: ${value}`).toBe(true);
    }
  });
});

describe("applyPreset", () => {
  it("swaps the look but keeps what belongs to the map", () => {
    const start = {
      ...DEFAULT_STYLE,
      layout: "tree-down" as const,
      view: "3d" as const,
      overrides: { x: { emoji: "⭐" } },
      link: { ...DEFAULT_STYLE.link, particles: 5 },
    };
    const next = applyPreset(start, "blueprint");
    expect(next.preset).toBe("blueprint");
    expect(next.layout).toBe("tree-down");
    expect(next.view).toBe("3d");
    expect(next.overrides).toEqual({ x: { emoji: "⭐" } });
    // Blueprint sets its own link look; nothing leaks in from before.
    expect(next.link.particles).toBe(0);
  });

  it("ignores unknown presets", () => {
    expect(applyPreset(DEFAULT_STYLE, "nope")).toBe(DEFAULT_STYLE);
  });
});

describe("style codes", () => {
  it("round-trips, without carrying node overrides across maps", () => {
    const style = { ...applyPreset(DEFAULT_STYLE, "neon"), caption: { show: true, text: "Ünïcode ✨", watermark: false } };
    const withOverrides = { ...style, overrides: { a: { color: "#ffffff" } } };
    const code = encodeStyle(withOverrides);
    expect(code.startsWith("doqtri-style:")).toBe(true);

    const target = { ...DEFAULT_STYLE, overrides: { b: { emoji: "🔥" } } };
    const decoded = decodeStyle(code, target);
    expect(decoded).toEqual({ ...style, overrides: { b: { emoji: "🔥" } } });
  });

  it("rejects anything that is not a code", () => {
    expect(decodeStyle("hello", DEFAULT_STYLE)).toBeNull();
    expect(decodeStyle("doqtri-style:!!!", DEFAULT_STYLE)).toBeNull();
  });
});

describe("randomStyle", () => {
  it("always produces a style that survives parsing", () => {
    const rand = seeded(42);
    for (let i = 0; i < 50; i++) {
      const style = randomStyle(DEFAULT_STYLE, rand);
      expect(parseStyle(JSON.parse(JSON.stringify(style)))).toEqual(style);
    }
  });
});

const TREE: MindmapGraph = {
  nodes: [
    { id: "root", label: "Root", kind: "root", depth: 0 },
    { id: "a", label: "A", kind: "theme", depth: 1 },
    { id: "b", label: "B", kind: "theme", depth: 1 },
    { id: "a1", label: "A1", kind: "concept", depth: 2 },
    { id: "b1", label: "B1", kind: "concept", depth: 2 },
    { id: "b1x", label: "B1x", kind: "detail", depth: 3 },
  ],
  links: [
    { source: "root", target: "a" },
    { source: "root", target: "b" },
    { source: "a", target: "a1" },
    { source: "b", target: "b1" },
    { source: "b1", target: "b1x" },
  ],
};

describe("assignBranches", () => {
  it("colours a single tree by the root's children", () => {
    const { branch, maxDepth } = assignBranches(TREE);
    expect(branch.get("root")).toBe(-1);
    expect(branch.get("a")).toBe(0);
    expect(branch.get("a1")).toBe(0);
    expect(branch.get("b")).toBe(1);
    expect(branch.get("b1x")).toBe(1);
    expect(maxDepth).toBe(3);
  });

  it("colours a forest by root, with shared nodes going to the first branch", () => {
    const forest: MindmapGraph = {
      nodes: [
        { id: "d1", label: "Doc 1", kind: "document", depth: 0 },
        { id: "d2", label: "Doc 2", kind: "document", depth: 0 },
        { id: "hub", label: "Hub", kind: "hub", depth: 1 },
        { id: "c", label: "C", kind: "concept", depth: 1 },
      ],
      links: [
        { source: "d1", target: "hub" },
        { source: "d2", target: "hub" },
        { source: "d2", target: "c" },
      ],
    };
    const { branch } = assignBranches(forest);
    expect(branch.get("d1")).toBe(0);
    expect(branch.get("d2")).toBe(1);
    expect(branch.get("hub")).toBe(0);
    expect(branch.get("c")).toBe(1);
  });
});

describe("resolveLook", () => {
  const node = { id: "a", kind: "theme" as const, depth: 1 };

  it("uses the kind colours by default", () => {
    const look = resolveLook(DEFAULT_STYLE, node, 0, 3);
    expect(look.stroke).toBe(DEFAULT_STYLE.palette.kinds.theme.stroke);
  });

  it("uses the branch colour in branch mode", () => {
    const style = { ...DEFAULT_STYLE, colorMode: "branch" as const };
    const look = resolveLook(style, node, 1, 3);
    expect(look.accent).toBe(mix(style.palette.branches[1], style.palette.background, 0.08));
  });

  it("lets a node override win over every mode", () => {
    const style = { ...DEFAULT_STYLE, colorMode: "depth" as const, overrides: { a: { color: "#ff0000" } } };
    expect(resolveLook(style, node, 0, 3).accent).toBe("#ff0000");
  });

  it("adds a gradient stop only for gradient fills", () => {
    expect(resolveLook(DEFAULT_STYLE, node, 0, 3).fillTo).toBeUndefined();
    expect(resolveLook({ ...DEFAULT_STYLE, fill: "gradient" }, node, 0, 3).fillTo).toBeDefined();
  });
});

describe("displayLabel", () => {
  it("prefixes the emoji", () => {
    const style = { ...DEFAULT_STYLE, overrides: { a: { emoji: "🚀" } } };
    expect(displayLabel(style, { id: "a", label: "Launch" })).toBe("🚀 Launch");
    expect(displayLabel(style, { id: "b", label: "Plain" })).toBe("Plain");
  });
});

describe("overviewGraph", () => {
  // root, 3 themes, 9 concepts, 27 details
  const big: MindmapGraph = { nodes: [{ id: "r", label: "R", kind: "root", depth: 0 }], links: [] };
  for (let t = 0; t < 3; t++) {
    big.nodes.push({ id: `t${t}`, label: "T", kind: "theme", depth: 1 });
    big.links.push({ source: "r", target: `t${t}` });
    for (let c = 0; c < 3; c++) {
      big.nodes.push({ id: `c${t}${c}`, label: "C", kind: "concept", depth: 2 });
      big.links.push({ source: `t${t}`, target: `c${t}${c}` });
      for (let d = 0; d < 3; d++) {
        big.nodes.push({ id: `d${t}${c}${d}`, label: "D", kind: "detail", depth: 3 });
        big.links.push({ source: `c${t}${c}`, target: `d${t}${c}${d}` });
      }
    }
  }

  it("keeps whole levels that fit the budget", () => {
    const { graph, depth } = overviewGraph(big, 20);
    expect(depth).toBe(2);
    expect(graph.nodes).toHaveLength(13);
    expect(graph.links).toHaveLength(12);
    for (const link of graph.links) {
      expect(graph.nodes.some((n) => n.id === link.source)).toBe(true);
      expect(graph.nodes.some((n) => n.id === link.target)).toBe(true);
    }
  });

  it("returns everything when it all fits", () => {
    expect(overviewGraph(big, 1000).graph.nodes).toHaveLength(40);
  });

  it("always keeps the root level", () => {
    expect(overviewGraph(big, 0).graph.nodes).toHaveLength(1);
  });
});

describe("particlesPerLink", () => {
  const style = { ...DEFAULT_STYLE, link: { ...DEFAULT_STYLE.link, particles: 4 } };
  it("gives a small map what it asks for", () => {
    expect(particlesPerLink(style, 50)).toBe(4);
  });
  it("thins them out on a big map", () => {
    expect(particlesPerLink(style, 300)).toBe(2);
  });
  it("turns them off on a very big map", () => {
    expect(particlesPerLink(style, 1213)).toBe(0);
  });
});

describe("createFocusIndex", () => {
  // root → a, b; a → a1, a2; b → b1; a1 → x
  const graph: MindmapGraph = {
    nodes: ["root", "a", "b", "a1", "a2", "b1", "x", "c", "d", "e"].map((id, i) => ({
      id,
      label: id,
      kind: "concept" as const,
      depth: i,
    })),
    links: [
      { source: "root", target: "a" },
      { source: "root", target: "b" },
      { source: "a", target: "a1" },
      { source: "a", target: "a2" },
      { source: "b", target: "b1" },
      { source: "a1", target: "x" },
      { source: "root", target: "c" },
      { source: "root", target: "d" },
      { source: "root", target: "e" },
    ],
  };
  const focus = createFocusIndex(graph);

  it("lights the node, its subtree, and its path to the root", () => {
    expect([...focus("a")!].sort()).toEqual(["a", "a1", "a2", "root", "x"]);
  });

  it("lights only the path for a leaf", () => {
    expect([...focus("x")!].sort()).toEqual(["a", "a1", "root", "x"]);
  });

  it("dims nothing when nearly the whole map is related", () => {
    expect(focus("root")).toBeNull();
  });

  it("keeps every route up from a node with two parents", () => {
    const hub = createFocusIndex({
      nodes: ["d1", "d2", "d3", "hub", "z1", "z2", "z3"].map((id) => ({ id, label: id, kind: "concept" as const, depth: 0 })),
      links: [
        { source: "d1", target: "hub" },
        { source: "d2", target: "hub" },
      ],
    });
    expect([...hub("hub")!].sort()).toEqual(["d1", "d2", "hub"]);
  });
});

describe("revealAlpha", () => {
  it("always shows the root and its first ring", () => {
    expect(revealAlpha(0.1, 0)).toBe(1);
    expect(revealAlpha(0.1, 1)).toBe(1);
  });

  it("fades a level in as its labels grow legible", () => {
    expect(revealAlpha(3, 2)).toBe(0);
    expect(revealAlpha(5.5, 2)).toBeCloseTo(0.5);
    expect(revealAlpha(8, 2)).toBe(1);
  });

  it("reveals deeper levels only at closer zoom", () => {
    // A size that fully shows level 2 still hides level 3.
    expect(revealAlpha(7, 2)).toBe(1);
    expect(revealAlpha(7, 3)).toBe(0);
    expect(revealAlpha(10, 3)).toBe(1);
  });
});
