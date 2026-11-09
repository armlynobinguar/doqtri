import { describe, expect, it } from "vitest";
import { withoutLink } from "@/lib/node-links";

describe("removing a GitHub link before its delete answers (DOQ-33)", () => {
  const rows = [
    { id: "a", node_id: "h1" },
    { id: "b", node_id: "h2" },
  ];

  it("hides the link at once, and a failed delete rolls back to the rows it started from", () => {
    const before = structuredClone(rows);
    expect(withoutLink(rows, "a")).toEqual([{ id: "b", node_id: "h2" }]);
    expect(rows).toEqual(before);
  });

  it("changes nothing more when the reload no longer has the link", () => {
    const reloaded = withoutLink(rows, "a");
    expect(withoutLink(reloaded, "a")).toEqual(reloaded);
  });
});
