import { describe, expect, it } from "vitest";
import { countWords } from "@/lib/text-stats";

describe("countWords", () => {
  it("counts words split by any whitespace", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("  one\ttwo\n\nthree ")).toBe(3);
    expect(countWords("# Title **bold**")).toBe(3);
  });
});
