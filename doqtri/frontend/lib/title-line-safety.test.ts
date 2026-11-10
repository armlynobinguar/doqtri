import { describe, expect, it, vi } from "vitest";
import { readTitleLineSafety, type SafetyReads } from "@/lib/title-line-safety";

/** Reads that find what `found` says, each failing instead when it says "fail". */
function reads(found: Partial<Record<keyof SafetyReads, boolean | "fail">> = {}): SafetyReads {
  const read = (key: keyof SafetyReads) =>
    vi.fn(async () => {
      if (found[key] === "fail") throw new Error(`${key} unavailable`);
      return found[key] === true;
    });
  return { hasNodeLinks: read("hasNodeLinks"), hasChainWrites: read("hasChainWrites"), isRegistered: read("isRegistered") };
}

describe("readTitleLineSafety (D-120)", () => {
  it("allows the title line only when nothing hangs off the note's headings", async () => {
    const all = reads();
    expect(await readTitleLineSafety("n1", all)).toBe("allowed");
    expect(all.hasNodeLinks).toHaveBeenCalledWith("n1");
    expect(all.hasChainWrites).toHaveBeenCalledWith("n1");
    expect(all.isRegistered).toHaveBeenCalledWith("n1");
  });

  it("blocks it for a note with a linked heading, a chain write, or a ledger record", async () => {
    expect(await readTitleLineSafety("n1", reads({ hasNodeLinks: true }))).toBe("blocked");
    expect(await readTitleLineSafety("n1", reads({ hasChainWrites: true }))).toBe("blocked");
    expect(await readTitleLineSafety("n1", reads({ isRegistered: true }))).toBe("blocked");
  });

  it("blocks it when anything cannot be read: the note is left as it is", async () => {
    for (const key of ["hasNodeLinks", "hasChainWrites", "isRegistered"] as const) {
      expect(await readTitleLineSafety("n1", reads({ [key]: "fail" })), key).toBe("blocked");
    }
  });
});
