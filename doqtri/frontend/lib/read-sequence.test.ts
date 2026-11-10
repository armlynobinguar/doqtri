import { describe, expect, it } from "vitest";
import { ReadSequence } from "@/lib/read-sequence";

describe("dropping stale reloads (DOQ-33)", () => {
  it("keeps a reload nothing overtook", () => {
    const reads = new ReadSequence();
    const ticket = reads.start();
    expect(reads.isCurrent(ticket)).toBe(true);
  });

  it("drops a reload that started before a write succeeded", () => {
    const reads = new ReadSequence();
    const before = reads.start();
    reads.invalidate();
    expect(reads.isCurrent(before)).toBe(false);
    // The write's own reload, started afterwards, is kept.
    expect(reads.isCurrent(reads.start())).toBe(true);
  });

  it("drops an older reload whatever order the answers come back in", () => {
    const reads = new ReadSequence();
    const first = reads.start();
    const second = reads.start();
    expect(reads.isCurrent(second)).toBe(true);
    expect(reads.isCurrent(first)).toBe(false);
  });
});
