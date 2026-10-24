import { describe, expect, it } from "vitest";
import { MAX_NODES_PER_CALL } from "@/lib/bindings/doqtri-registry";
import { buildMindmap } from "@/lib/mindmap";
import {
  anchorBatches,
  MAX_NODES_PER_ANCHOR,
  planRollups,
  rollupOf,
  rollupRef,
  type NodeUpdate,
  type RecordLike,
} from "@/lib/node-rollup";

/*
 * Roll-ups (WP-2.8, D-24, contract section 11) and batching node writes into
 * as few anchor calls as fit (R-04).
 */

// root
//   h0 Plan
//     h1 Escrow        (qdit)
//     h2 Payroll
//       h3 Contract    (qdit)
//       h4 UI          (GitHub)
//   h5 Launch
const TREE = buildMindmap("Doc", "# Plan\n## Escrow\n## Payroll\n### Contract\n### UI\n# Launch");
const LINKED = ["h1", "h3", "h4"];

const rec = (status: string, tool = "qdit", artifactRef = "x"): RecordLike => ({ status, tool, artifactRef });
const qdit = (nodeId: string, status: NodeUpdate["status"]): NodeUpdate => ({ nodeId, status, tool: "qdit", artifactRef: "ref" });

describe("rollupOf (D-24)", () => {
  it("applies the rules in order", () => {
    expect(rollupOf(["Verified", "Verified"])).toBe("Verified");
    expect(rollupOf(["Verified", "Built"])).toBe("Built");
    expect(rollupOf(["Built", "Built"])).toBe("Built");
    expect(rollupOf(["Built", "Building", "Verified"])).toBe("Building");
    expect(rollupOf(["Planned", "Building"])).toBe("Building");
    expect(rollupOf(["Planned", "Verified"])).toBe("Planned");
    expect(rollupOf(["Planned"])).toBe("Planned");
  });

  it("names the direct children in document order", () => {
    expect(rollupRef(["h3", "h4", "h7"])).toBe("children:h3,h4,h7");
  });
});

describe("planRollups", () => {
  it("writes nothing for a plan with no statuses yet", () => {
    const plan = planRollups({ tree: TREE, records: {}, linked: LINKED });
    expect(plan.updates).toEqual([]);
    expect(Object.values(plan.statuses).every((s) => s === "Planned")).toBe(true);
  });

  it("rolls a signed milestone up through its ancestors, children first", () => {
    const plan = planRollups({
      tree: TREE,
      records: { h1: rec("Verified"), h4: rec("Verified", "github") },
      linked: LINKED,
      pending: [qdit("h3", "Verified")],
    });
    expect(plan.updates).toEqual([
      { nodeId: "h2", status: "Verified", tool: "rollup", artifactRef: "children:h3,h4" },
      { nodeId: "h0", status: "Verified", tool: "rollup", artifactRef: "children:h1,h2" },
      // h5 has no children: it is a leaf, Planned, so root is Planned and has no record: nothing to write.
    ]);
    expect(plan.statuses).toMatchObject({ h0: "Verified", h2: "Verified", h3: "Verified", root: "Planned" });
  });

  it("counts a rejected milestone as Building all the way up", () => {
    const plan = planRollups({
      tree: TREE,
      records: { h1: rec("Built"), h2: rec("Built", "rollup", "children:h3,h4"), h0: rec("Built", "rollup", "children:h1,h2") },
      linked: LINKED,
      pending: [qdit("h3", "Building")],
    });
    expect(plan.updates.map((u) => [u.nodeId, u.status])).toEqual([
      ["h2", "Building"],
      ["h0", "Building"],
      ["root", "Building"],
    ]);
  });

  it("writes nothing the ledger already says", () => {
    const plan = planRollups({
      tree: TREE,
      records: {
        h1: rec("Verified"),
        h3: rec("Verified"),
        h4: rec("Verified", "github"),
        h2: rec("Verified", "rollup", "children:h3,h4"),
        h0: rec("Verified", "rollup", "children:h1,h2"),
      },
      linked: LINKED,
    });
    expect(plan.updates).toEqual([]);
  });

  it("rewrites a roll-up whose children changed (the headings moved)", () => {
    const plan = planRollups({
      tree: TREE,
      records: { h1: rec("Verified"), h3: rec("Verified"), h4: rec("Verified", "github"), h2: rec("Verified", "rollup", "children:h2,h3") },
      linked: LINKED,
    });
    expect(plan.updates[0]).toEqual({ nodeId: "h2", status: "Verified", tool: "rollup", artifactRef: "children:h3,h4" });
  });

  it("never overwrites a parent somebody signed by hand, and counts its record", () => {
    const plan = planRollups({
      tree: TREE,
      records: { h1: rec("Verified"), h2: rec("Built", "manual"), root: rec("Verified", "doqtri-done", "v3") },
      linked: LINKED,
      pending: [qdit("h3", "Verified")],
    });
    expect(plan.keptByHand).toEqual(["h2", "root"]);
    expect(plan.updates).toEqual([{ nodeId: "h0", status: "Built", tool: "rollup", artifactRef: "children:h1,h2" }]);
  });

  it("gives a linked parent its own status, never a roll-up", () => {
    const tree = buildMindmap("Doc", "# Plan\n## A\n## B");
    const plan = planRollups({
      tree,
      records: { h1: rec("Verified"), h2: rec("Verified") },
      linked: ["h0"],
      pending: [qdit("h0", "Built")],
    });
    expect(plan.statuses.h0).toBe("Built");
    // Not h0 (linked), only the root above it.
    expect(plan.updates).toEqual([{ nodeId: "root", status: "Built", tool: "rollup", artifactRef: "children:h0" }]);
  });
});

describe("anchorBatches (R-04)", () => {
  it("matches the registry's limit", () => {
    expect(MAX_NODES_PER_ANCHOR).toBe(MAX_NODES_PER_CALL);
  });

  it("keeps everything in one call when it fits, and splits in order when not", () => {
    const updates = Array.from({ length: 70 }, (_, i) => qdit(`h${i}`, "Built"));
    expect(anchorBatches(updates.slice(0, 32))).toHaveLength(1);
    const batches = anchorBatches(updates);
    expect(batches.map((b) => b.length)).toEqual([32, 32, 6]);
    expect(batches.flat()).toEqual(updates);
    expect(anchorBatches([])).toEqual([]);
  });
});
