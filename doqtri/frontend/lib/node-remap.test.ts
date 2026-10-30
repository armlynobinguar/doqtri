import { describe, expect, it } from "vitest";
import {
  alignHeadings,
  headingsOf,
  planRemap,
  remapChanges,
  type RemapLink,
} from "@/lib/node-remap";

const doc = (...lines: string[]) => lines.join("\n");
const qdit = (id: string, nodeId: string, nodeLabel: string, qditState: RemapLink["qditState"] = "linked"): RemapLink => ({
  id,
  provider: "qdit",
  nodeId,
  nodeLabel,
  qditState,
});
const github = (id: string, nodeId: string, nodeLabel: string): RemapLink => ({
  id,
  provider: "github",
  nodeId,
  nodeLabel,
});

describe("headingsOf", () => {
  it("lists headings in document order with their ids and depth", () => {
    expect(headingsOf("Plan", doc("# A", "text", "## B", "# C"))).toEqual([
      { id: "h0", label: "A", depth: 1 },
      { id: "h1", label: "B", depth: 2 },
      { id: "h2", label: "C", depth: 1 },
    ]);
  });
});

describe("alignHeadings", () => {
  it("pairs headings that kept their label, in order", () => {
    const before = headingsOf("t", doc("# A", "# B", "# C"));
    const after = headingsOf("t", doc("# X", "# A", "# B2", "# C"));
    expect([...alignHeadings(before, after)!.entries()]).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});

describe("planRemap: contract section 11, labels only", () => {
  const after = headingsOf("t", doc("# Intro", "# Escrow contract", "# Payroll"));

  it("1. keeps a link whose heading still reads its label", () => {
    expect(planRemap([qdit("a", "h1", "Escrow contract")], after).get("a")).toEqual({ kind: "keep" });
  });

  it("compares labels after trimming, case-sensitive", () => {
    expect(planRemap([qdit("a", "h1", "  Escrow contract ")], after).get("a")).toEqual({ kind: "keep" });
    expect(planRemap([qdit("a", "h1", "escrow contract")], after).get("a")).toEqual({
      kind: "rename",
      to: "h1",
      label: "Escrow contract",
    });
  });

  it("2. moves a link whose label is at exactly one other id", () => {
    expect(planRemap([qdit("a", "h0", "Escrow contract")], after).get("a")).toEqual({ kind: "move", to: "h1" });
  });

  it("3. is ambiguous when the label is at several other ids", () => {
    const twice = headingsOf("t", doc("# Intro", "# Tests", "# Tests"));
    expect(planRemap([qdit("a", "h0", "Tests")], twice).get("a")).toEqual({ kind: "ambiguous" });
  });

  it("4. renames when the label is gone and the id still exists", () => {
    expect(planRemap([qdit("a", "h2", "Salaries")], after).get("a")).toEqual({
      kind: "rename",
      to: "h2",
      label: "Payroll",
    });
  });

  it("5. is deleted when the label and the id are both gone", () => {
    expect(planRemap([qdit("a", "h7", "Salaries")], after).get("a")).toEqual({ kind: "deleted" });
  });

  it("handles moves before renames: a heading another link moved onto is not a rename target", () => {
    // B was deleted, so C moved up to h1. B's link must not take C's text.
    const now = headingsOf("t", doc("# A", "# C"));
    const plan = planRemap([qdit("b", "h1", "B"), qdit("c", "h2", "C")], now);
    expect(plan.get("c")).toEqual({ kind: "move", to: "h1" });
    // Deleted, and parked out of C's way.
    expect(plan.get("b")).toEqual({ kind: "park", to: "h3", as: "deleted" });
  });

  it("never touches the root", () => {
    expect(planRemap([github("r", "root", "Old title")], after).get("r")).toEqual({ kind: "keep" });
  });
});

describe("planRemap: structure from the text before the save", () => {
  it("an inserted heading shifts every link after it", () => {
    const before = headingsOf("t", doc("# A", "# B", "# C"));
    const after = headingsOf("t", doc("# New", "# A", "# B", "# C"));
    const plan = planRemap([qdit("a", "h0", "A"), qdit("b", "h1", "B"), qdit("c", "h2", "C")], after, before);
    expect([...plan.values()]).toEqual([
      { kind: "move", to: "h1" },
      { kind: "move", to: "h2" },
      { kind: "move", to: "h3" },
    ]);
  });

  it("a heading inserted above a renamed one: the rename follows the heading, not the id", () => {
    const before = headingsOf("t", doc("# A", "# B", "# C"));
    const after = headingsOf("t", doc("# X", "# A", "# B2", "# C"));
    expect(planRemap([qdit("b", "h1", "B")], after, before).get("b")).toEqual({
      kind: "rename",
      to: "h2",
      label: "B2",
    });
    // Labels alone would have renamed the milestone after "A".
    expect(planRemap([qdit("b", "h1", "B")], after).get("b")).toEqual({ kind: "rename", to: "h1", label: "A" });
  });

  it("finds a heading among several of the same name by where it sits", () => {
    const before = headingsOf("t", doc("# Backend", "## Tests", "# Frontend", "## Tests"));
    const after = headingsOf("t", doc("# Intro", "# Backend", "## Tests", "# Frontend", "## Tests"));
    const plan = planRemap([qdit("be", "h1", "Tests"), qdit("fe", "h3", "Tests")], after, before);
    expect(plan.get("be")).toEqual({ kind: "move", to: "h2" });
    expect(plan.get("fe")).toEqual({ kind: "move", to: "h4" });
  });

  it("a heading deleted between unchanged neighbours is deleted, even though its id still exists", () => {
    const before = headingsOf("t", doc("# A", "# B", "# C"));
    const after = headingsOf("t", doc("# A", "# C"));
    expect(planRemap([qdit("b", "h1", "B")], after, before).get("b")).toEqual({ kind: "deleted" });
  });

  it("is ambiguous when a gap gained or lost headings around the renamed one", () => {
    const before = headingsOf("t", doc("# A", "# B", "# C"));
    const after = headingsOf("t", doc("# A", "# B1", "# B2", "# C"));
    expect(planRemap([qdit("b", "h1", "B")], after, before).get("b")).toEqual({ kind: "ambiguous" });
  });

  it("falls back to labels when the stored link does not match the old text", () => {
    const before = headingsOf("t", doc("# A", "# Other", "# C"));
    const after = headingsOf("t", doc("# A", "# Renamed", "# C"));
    expect(planRemap([qdit("b", "h1", "B")], after, before).get("b")).toEqual({
      kind: "rename",
      to: "h1",
      label: "Renamed",
    });
  });
});

describe("planRemap: two links never share a heading", () => {
  it("swaps two links whose headings swapped", () => {
    const after = headingsOf("t", doc("# B", "# A"));
    const plan = planRemap([qdit("a", "h0", "A"), qdit("b", "h1", "B")], after);
    expect(plan.get("a")).toEqual({ kind: "move", to: "h1" });
    expect(plan.get("b")).toEqual({ kind: "move", to: "h0" });
  });

  it("a move onto a heading another link keeps is ambiguous", () => {
    // A was renamed "B" while B is still there: two "B"s, one keeps its link.
    const after = headingsOf("t", doc("# A", "# B", "# Z"));
    const plan = planRemap([qdit("x", "h2", "B"), github("g", "h1", "B")], after);
    expect(plan.get("g")).toEqual({ kind: "keep" });
    expect(plan.get("x")).toEqual({ kind: "ambiguous" });
  });

  it("GitHub links follow where their heading went, never a new label", () => {
    const before = headingsOf("t", doc("# A", "# B"));
    const after = headingsOf("t", doc("# New", "# A", "# B2"));
    const links = [github("a", "h0", "A"), github("b", "h1", "B")];
    const plan = planRemap(links, after, before);
    expect(plan.get("a")).toEqual({ kind: "move", to: "h1" });
    // Renamed: it follows the heading but keeps its label, so the ship panel
    // still says the heading changed, as before.
    expect(plan.get("b")).toEqual({ kind: "move", to: "h2" });
    expect(remapChanges(links, plan)).toEqual([
      { id: "a", node_id: "h1" },
      { id: "b", node_id: "h2" },
    ]);
  });

  it("a GitHub link on a renamed heading stays put when nothing needs its id", () => {
    const after = headingsOf("t", doc("# A", "# B2"));
    const links = [github("b", "h1", "B")];
    expect(planRemap(links, after).get("b")).toEqual({ kind: "stale" });
    expect(remapChanges(links, planRemap(links, after))).toEqual([]);
  });

  it("deleting a linked heading lets the links after it move up; the deleted one is parked", () => {
    const before = headingsOf("t", doc("# A", "# B", "# C", "# D"));
    const after = headingsOf("t", doc("# A", "# C", "# D"));
    const links = [qdit("b", "h1", "B"), qdit("c", "h2", "C"), github("d", "h3", "D")];
    for (const plan of [planRemap(links, after, before), planRemap(links, after)]) {
      expect(plan.get("c")).toEqual({ kind: "move", to: "h1" });
      expect(plan.get("d")).toEqual({ kind: "move", to: "h2" });
      expect(plan.get("b")).toEqual({ kind: "park", to: "h4", as: "deleted" });
      expect(remapChanges(links, plan)).toEqual([
        { id: "b", node_id: "h4", qdit_state: "broken" },
        { id: "c", node_id: "h1", qdit_state: "pending" },
        { id: "d", node_id: "h2" },
      ]);
    }
  });

  it("a renamed GitHub heading in the way of a move is parked, not lost", () => {
    const after = headingsOf("t", doc("# New", "# A", "# B2"));
    const plan = planRemap([github("a", "h0", "A"), github("b", "h1", "B")], after);
    expect(plan.get("a")).toEqual({ kind: "move", to: "h1" });
    expect(plan.get("b")).toEqual({ kind: "park", to: "h3", as: "stale" });
  });

  it("two links moving onto one heading both stay, flagged", () => {
    const after = headingsOf("t", doc("# X", "# A"));
    const plan = planRemap([qdit("p", "h5", "A"), qdit("q", "h6", "A")], after);
    expect(plan.get("p")).toEqual({ kind: "ambiguous" });
    expect(plan.get("q")).toEqual({ kind: "ambiguous" });
  });

  it("a qdit link moving onto a GitHub link that also moves away is fine", () => {
    const before = headingsOf("t", doc("# A", "# B"));
    const after = headingsOf("t", doc("# New", "# A", "# B"));
    const plan = planRemap([qdit("q", "h0", "A"), github("g", "h1", "B")], after, before);
    expect(plan.get("q")).toEqual({ kind: "move", to: "h1" });
    expect(plan.get("g")).toEqual({ kind: "move", to: "h2" });
  });
});

describe("planRemap: flagged links wait for a relink", () => {
  it("a parked broken link is not renamed after a heading that later takes its id", () => {
    const after = headingsOf("t", doc("# A", "# C", "# D", "# E", "# New"));
    const plan = planRemap([qdit("b", "h4", "B", "broken")], after);
    expect(plan.get("b")).toEqual({ kind: "deleted" });
    expect(remapChanges([qdit("b", "h4", "B", "broken")], plan)).toEqual([]);
  });

  it("an ambiguous link is not renamed either", () => {
    const after = headingsOf("t", doc("# A", "# Other"));
    expect(planRemap([qdit("x", "h1", "Tests", "ambiguous")], after).get("x")).toEqual({ kind: "ambiguous" });
  });

  it("but a deleted heading that comes back takes its link back", () => {
    const after = headingsOf("t", doc("# A", "# B", "# C"));
    const links = [qdit("b", "h7", "B", "broken")];
    const plan = planRemap(links, after);
    expect(plan.get("b")).toEqual({ kind: "move", to: "h1" });
    expect(remapChanges(links, plan)).toEqual([{ id: "b", node_id: "h1", qdit_state: "pending" }]);
  });
});

describe("remapChanges", () => {
  it("writes only rows that change, with the qdit state they reach", () => {
    const after = headingsOf("t", doc("# New", "# A", "# C", "# Tests", "# Tests"));
    const links = [
      qdit("a", "h0", "A"),
      qdit("ok", "h2", "C"),
      qdit("dup", "h9", "Tests"),
      qdit("gone", "h8", "Gone"),
      qdit("still", "h7", "Gone too", "broken"),
    ];
    expect(remapChanges(links, planRemap(links, after))).toEqual([
      { id: "a", node_id: "h1", qdit_state: "pending" },
      { id: "dup", node_id: "h9", qdit_state: "ambiguous" },
      { id: "gone", node_id: "h8", qdit_state: "broken" },
    ]);
  });

  it("moves a GitHub link without a qdit state", () => {
    const after = headingsOf("t", doc("# New", "# A"));
    const links = [github("g", "h0", "A")];
    expect(remapChanges(links, planRemap(links, after))).toEqual([{ id: "g", node_id: "h1" }]);
  });

  it("re-sends a flagged link that reads right again, and leaves one already flagged alone", () => {
    const after = headingsOf("t", doc("# A", "# B", "# B"));
    const links = [qdit("a", "h0", "A", "ambiguous"), qdit("b", "h5", "B", "ambiguous")];
    expect(remapChanges(links, planRemap(links, after))).toEqual([
      { id: "a", node_id: "h0", qdit_state: "pending" },
    ]);
  });

  it("stores the new label of a renamed heading", () => {
    const after = headingsOf("t", doc("# Escrow v2"));
    const links = [qdit("a", "h0", "Escrow")];
    expect(remapChanges(links, planRemap(links, after))).toEqual([
      { id: "a", node_id: "h0", node_label: "Escrow v2", qdit_state: "pending" },
    ]);
  });
});
