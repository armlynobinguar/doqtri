import { describe, expect, it } from "vitest";
import { RATING_CRITERIA, parseRating, ratingTotal, type PromoRating } from "./promo-rating";

function criteria(score: number): PromoRating["criteria"] {
  return Object.fromEntries(
    RATING_CRITERIA.map((c) => [c.key, { score, note: "" }]),
  ) as PromoRating["criteria"];
}

describe("ratingTotal", () => {
  it("maps all-zero and all-ten to 0 and 100", () => {
    expect(ratingTotal(criteria(0))).toBe(0);
    expect(ratingTotal(criteria(10))).toBe(100);
    expect(ratingTotal(criteria(5))).toBe(50);
  });

  it("weights criteria rather than averaging them", () => {
    const strongStructure = { ...criteria(0), structure: { score: 10, note: "" } };
    const strongOriginality = { ...criteria(0), originality: { score: 10, note: "" } };
    expect(ratingTotal(strongStructure)).toBeGreaterThan(ratingTotal(strongOriginality));
  });

  it("uses weights that sum to 100", () => {
    expect(RATING_CRITERIA.reduce((sum, c) => sum + c.weight, 0)).toBe(100);
  });
});

describe("parseRating", () => {
  const raw = {
    criteria: Object.fromEntries(RATING_CRITERIA.map((c) => [c.key, { score: 7, note: " ok " }])),
    summary: "Solid map.",
    flags: ["off_brief"],
  };

  it("accepts a complete rating", () => {
    const rating = parseRating(raw, "gpt-4o");
    expect(rating?.criteria.structure).toEqual({ score: 7, note: "ok" });
    expect(rating?.flags).toEqual(["off_brief"]);
    expect(rating?.model).toBe("gpt-4o");
  });

  it("clamps out-of-range scores", () => {
    const rating = parseRating(
      {
        ...raw,
        criteria: { ...raw.criteria, structure: { score: 42, note: "" }, depth: { score: -3, note: "" } },
      },
      "m",
    );
    expect(rating?.criteria.structure.score).toBe(10);
    expect(rating?.criteria.depth.score).toBe(0);
  });

  it("drops unknown and repeated flags", () => {
    const rating = parseRating({ ...raw, flags: ["winner", "unreadable", "unreadable"] }, "m");
    expect(rating?.flags).toEqual(["unreadable"]);
  });

  it("refuses a rating missing a criterion", () => {
    const partial = { ...raw.criteria } as Record<string, unknown>;
    delete partial.structure;
    expect(parseRating({ ...raw, criteria: partial }, "m")).toBeNull();
    expect(parseRating(null, "m")).toBeNull();
    expect(parseRating("90", "m")).toBeNull();
  });
});
