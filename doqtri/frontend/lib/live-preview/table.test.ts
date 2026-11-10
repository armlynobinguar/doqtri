import { describe, expect, it } from "vitest";
import { parseAlignments, parseTable, splitRow } from "@/lib/live-preview/table";
import { inlineNodes, plainText } from "@/lib/live-preview/inline";
import { loadableImageUrl } from "@/lib/live-preview/image";

const line = (text: string, from = 0) => ({ text, from });

describe("splitRow", () => {
  it("splits on pipes, trims cells and keeps their document offsets", () => {
    const cells = splitRow(line("| a |  bb | c |", 10));
    expect(cells.map((c) => c.text)).toEqual(["a", "bb", "c"]);
    expect(cells.map((c) => [c.from, c.to])).toEqual([
      [12, 13],
      [17, 19],
      [22, 23],
    ]);
  });

  it("treats the outer pipes as optional", () => {
    expect(splitRow(line("a | b")).map((c) => c.text)).toEqual(["a", "b"]);
    expect(splitRow(line("  | a | b")).map((c) => c.text)).toEqual(["a", "b"]);
  });

  it("keeps escaped pipes inside their cell", () => {
    expect(splitRow(line("| a \\| b | c |")).map((c) => c.text)).toEqual(["a \\| b", "c"]);
  });

  it("keeps empty cells", () => {
    expect(splitRow(line("| a |  | c |")).map((c) => c.text)).toEqual(["a", "", "c"]);
  });
});

describe("parseAlignments", () => {
  it("reads alignment from the delimiter row's colons", () => {
    expect(parseAlignments(line("| :-- | :-: | --: | --- |"))).toEqual(["left", "center", "right", null]);
  });
});

describe("parseTable", () => {
  it("pads short rows and cuts long ones to the header's columns", () => {
    const table = parseTable([line("| a | b |"), line("| - | - |", 10), line("| 1 |", 20), line("| 1 | 2 | 3 |", 26)]);
    expect(table?.rows.map((row) => row.map((c) => c.text))).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
  });

  it("is null when the header and delimiter row disagree", () => {
    expect(parseTable([line("| a | b |"), line("| - |")])).toBeNull();
    expect(parseTable([line("| a |")])).toBeNull();
  });
});

describe("inlineNodes", () => {
  it("renders the inline formatting a cell can carry", () => {
    expect(inlineNodes("**b** _i_ ~~s~~ `c` [l](https://x.example) [[Note|alias]] \\|")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "b" }] },
      { kind: "text", text: " " },
      { kind: "em", children: [{ kind: "text", text: "i" }] },
      { kind: "text", text: " " },
      { kind: "del", children: [{ kind: "text", text: "s" }] },
      { kind: "text", text: " " },
      { kind: "code", text: "c" },
      { kind: "text", text: " " },
      { kind: "link", href: "https://x.example", children: [{ kind: "text", text: "l" }] },
      { kind: "text", text: " " },
      { kind: "wikilink", target: "Note", text: "alias" },
      { kind: "text", text: " |" },
    ]);
  });

  it("shows an image's alt text instead of loading it", () => {
    expect(inlineNodes("![alt](https://x.example/a.png)")).toEqual([{ kind: "text", text: "alt" }]);
  });

  it("knows when a cell renders exactly as typed", () => {
    expect(plainText(inlineNodes("plain words"))).toBe("plain words");
    expect(plainText(inlineNodes("**b**"))).toBe("b");
  });
});

describe("loadableImageUrl", () => {
  it("allows http and https only", () => {
    expect(loadableImageUrl("https://img.example/a.png")).toBe("https://img.example/a.png");
    expect(loadableImageUrl("HTTP://img.example/a.png")).toBe("http://img.example/a.png");
    expect(loadableImageUrl("<https://img.example/a b.png>")).toBe("https://img.example/a%20b.png");
    for (const url of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "/relative.png",
      "relative.png",
      "//cdn.example/a.png",
      "file:///etc/passwd",
      "blob:https://x/1",
      "https://",
      "ftp://x.example/a.png",
    ]) {
      expect(loadableImageUrl(url), url).toBeNull();
    }
  });
});
