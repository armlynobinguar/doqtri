import { describe, expect, it } from "vitest";
import { MINDMAP_PROMO, promoFilesProblem, promoPathsInFolder } from "./promo";

const USER = "11111111-1111-4111-8111-111111111111";
const UPLOAD = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

describe("promoFilesProblem", () => {
  const png = { type: "image/png", size: 1000 };

  it("accepts one to four screenshots", () => {
    expect(promoFilesProblem([png])).toBeNull();
    expect(promoFilesProblem([png, png, png, png])).toBeNull();
  });

  it("refuses none or more than four", () => {
    expect(promoFilesProblem([])).toMatch(/at least one/);
    expect(promoFilesProblem([png, png, png, png, png])).toMatch(/up to 4/);
  });

  it("refuses other types, empty files and oversized files", () => {
    expect(promoFilesProblem([{ type: "image/gif", size: 10 }])).toMatch(/PNG/);
    expect(promoFilesProblem([{ type: "image/png", size: 0 }])).toMatch(/empty/);
    expect(
      promoFilesProblem([{ type: "image/jpeg", size: MINDMAP_PROMO.maxImageBytes + 1 }]),
    ).toMatch(/5 MB/);
  });
});

describe("promoPathsInFolder", () => {
  const path = (name: string, user = USER, upload = UPLOAD) => `${user}/${upload}/${name}`;

  it("returns the file names of paths in the caller's upload folder", () => {
    expect(promoPathsInFolder([path("0.png"), path("1.webp")], USER, UPLOAD)).toEqual([
      "0.png",
      "1.webp",
    ]);
  });

  it("refuses another user's folder or another upload", () => {
    expect(promoPathsInFolder([path("0.png", OTHER)], USER, UPLOAD)).toBeNull();
    expect(promoPathsInFolder([path("0.png", USER, OTHER)], USER, UPLOAD)).toBeNull();
  });

  it("refuses traversal, odd names, duplicates and bad upload ids", () => {
    expect(promoPathsInFolder([path("../0.png")], USER, UPLOAD)).toBeNull();
    expect(promoPathsInFolder([path("0/1.png")], USER, UPLOAD)).toBeNull();
    expect(promoPathsInFolder([path("0.png"), path("0.png")], USER, UPLOAD)).toBeNull();
    expect(promoPathsInFolder([path("0.png")], USER, "../x")).toBeNull();
  });

  it("refuses empty, oversized or non-array input", () => {
    expect(promoPathsInFolder([], USER, UPLOAD)).toBeNull();
    expect(promoPathsInFolder("0.png", USER, UPLOAD)).toBeNull();
    const five = ["0", "1", "2", "3", "4"].map((n) => path(`${n}.png`));
    expect(promoPathsInFolder(five, USER, UPLOAD)).toBeNull();
  });
});
