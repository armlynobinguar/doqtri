import { describe, expect, it } from "vitest";
import {
  buySplit,
  formatAmount,
  newTemplateId,
  parseAmount,
  sectionSimilarity,
  TEMPLATE_ID_PATTERN,
  templateBodyFromNote,
  templateOutline,
} from "./market";

const fees = { creatorBps: 8500, parentBps: 500, treasuryBps: 1000 };

describe("template ids", () => {
  it("are 16 base32 characters", () => {
    for (let i = 0; i < 50; i++) expect(newTemplateId()).toMatch(TEMPLATE_ID_PATTERN);
    expect(newTemplateId(() => new Uint8Array(16).fill(0))).toBe("aaaaaaaaaaaaaaaa");
    expect(newTemplateId(() => new Uint8Array(16).fill(31))).toBe("7777777777777777");
  });
});

describe("templateBodyFromNote", () => {
  it("drops the leading title and the blank lines after it", () => {
    expect(templateBodyFromNote("# Launch plan\n\n## Goals\nShip it\n")).toBe("## Goals\nShip it\n");
    expect(templateBodyFromNote("\n\n# Title\r\n\r\nBody")).toBe("Body\n");
  });

  it("keeps notes that don't start with a title", () => {
    expect(templateBodyFromNote("## Goals\nShip it")).toBe("## Goals\nShip it\n");
    expect(templateBodyFromNote("Intro\n# Later heading")).toBe("Intro\n# Later heading\n");
  });

  it("only treats `# ` as a title, not `##`", () => {
    expect(templateBodyFromNote("## Section\ntext")).toBe("## Section\ntext\n");
  });
});

describe("templateOutline", () => {
  it("keeps headings and nothing else", () => {
    const body = ["Intro paragraph", "## Goals", "- secret list", "### Metric", "Secret text", ""].join("\n");
    expect(templateOutline(body)).toBe("## Goals\n### Metric");
  });

  it("ignores heading-looking lines inside code fences", () => {
    const body = ["## Setup", "```sh", "# not a heading", "```", "## Run"].join("\n");
    expect(templateOutline(body)).toBe("## Setup\n## Run");
  });
});

describe("amounts", () => {
  it("formats smallest units", () => {
    expect(formatAmount(BigInt(30_000_000))).toBe("3");
    expect(formatAmount(BigInt(25_500_000))).toBe("2.55");
    expect(formatAmount(BigInt(1))).toBe("0.0000001");
    expect(formatAmount(BigInt(0))).toBe("0");
  });

  it("parses plain decimals and refuses everything else", () => {
    expect(parseAmount("3")).toBe(BigInt(30_000_000));
    expect(parseAmount("0.5")).toBe(BigInt(5_000_000));
    expect(parseAmount(" 2.55 ")).toBe(BigInt(25_500_000));
    expect(parseAmount("0.0000001")).toBe(BigInt(1));
    expect(parseAmount("0.00000001")).toBeNull();
    expect(parseAmount("-1")).toBeNull();
    expect(parseAmount("1e3")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("buySplit (mirrors the contract)", () => {
  const base = { buyer: "BUYER", creator: "ANA", treasury: "TREASURY", fees };

  it("pays creator, parent and treasury: 3 → 2.55 / 0.15 / 0.30", () => {
    const split = buySplit({ ...base, price: BigInt(30_000_000), parentCreator: "BEN" });
    expect(split.transfers).toEqual([
      { to: "ANA", amount: BigInt(25_500_000) },
      { to: "BEN", amount: BigInt(1_500_000) },
      { to: "TREASURY", amount: BigInt(3_000_000) },
    ]);
  });

  it("gives the parent share to the creator when there is no parent", () => {
    const split = buySplit({ ...base, price: BigInt(30_000_000), parentCreator: null });
    expect(split.transfers).toEqual([
      { to: "ANA", amount: BigInt(27_000_000) },
      { to: "TREASURY", amount: BigInt(3_000_000) },
    ]);
  });

  it("adds up exactly, remainder to the creator", () => {
    for (const price of [1, 2, 3, 7, 19, 21, 99, 101, 9_999, 10_001, 123_456_789].map(BigInt)) {
      for (const parentCreator of [null, "BEN"]) {
        const split = buySplit({ ...base, price, parentCreator });
        expect(split.creatorCut + split.parentCut + split.treasuryCut).toBe(price);
        expect(split.transfers.reduce((sum, t) => sum + t.amount, BigInt(0))).toBe(price);
      }
    }
  });

  it("merges the parent share when the parent's creator is the creator", () => {
    const split = buySplit({ ...base, price: BigInt(30_000_000), parentCreator: "ANA" });
    expect(split.transfers).toEqual([
      { to: "ANA", amount: BigInt(27_000_000) },
      { to: "TREASURY", amount: BigInt(3_000_000) },
    ]);
  });

  it("skips paying the buyer their own parent share", () => {
    const split = buySplit({ ...base, buyer: "BEN", price: BigInt(30_000_000), parentCreator: "BEN" });
    expect(split.transfers.map((t) => t.to)).toEqual(["ANA", "TREASURY"]);
  });

  it("makes no transfers for a free template", () => {
    expect(buySplit({ ...base, price: BigInt(0), parentCreator: "BEN" }).transfers).toEqual([]);
  });
});

describe("sectionSimilarity", () => {
  it("is 1 for the same structure and 0 for none in common", () => {
    expect(sectionSimilarity("## Goals\nA\n## Risks", "## Goals\nB\n## Risks")).toBe(1);
    expect(sectionSimilarity("## Goals", "## Budget")).toBe(0);
    expect(sectionSimilarity("no headings", "none here")).toBe(0);
  });

  it("ignores case, heading level and emphasis", () => {
    expect(sectionSimilarity("## **Goals**\n### Risks", "# goals\n## RISKS")).toBe(1);
  });

  it("is the share of headings in common", () => {
    expect(sectionSimilarity("## A\n## B\n## C", "## A\n## B\n## D")).toBe(0.5);
  });
});
