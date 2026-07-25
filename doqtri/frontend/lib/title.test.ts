import { describe, expect, it } from "vitest";
import { deriveTitle, uniqueTitle } from "@/lib/title";

describe("deriveTitle", () => {
  it("prefers the first h1", () => {
    expect(deriveTitle("# Real Title\n\ntext", "upload.pdf")).toBe("Real Title");
  });

  it("skips deeper headings when looking for an h1", () => {
    expect(deriveTitle("## Sub\n# Top\n", "upload.pdf")).toBe("Top");
  });

  it("falls back to the filename without its extension", () => {
    expect(deriveTitle("no headings here", "Q3 Report.pdf")).toBe("Q3 Report");
  });

  it("handles a filename with several dots", () => {
    expect(deriveTitle("", "notes.v2.final.docx")).toBe("notes.v2.final");
  });

  it("unwraps a heading that is itself a wikilink", () => {
    expect(deriveTitle("# [[Auth]]\n", "x.pdf")).toBe("Auth");
  });

  it("prefers a wikilink alias in the heading", () => {
    expect(deriveTitle("# [[Auth|Sign in]]\n", "x.pdf")).toBe("Sign in");
  });

  it("strips closing ATX hashes", () => {
    expect(deriveTitle("# Title #\n", "x.pdf")).toBe("Title");
  });

  it("returns Untitled when there is nothing to go on", () => {
    expect(deriveTitle("", "")).toBe("Untitled");
  });

  it("ignores an empty h1", () => {
    expect(deriveTitle("#\n\ntext", "fallback.txt")).toBe("fallback");
  });
});

describe("uniqueTitle", () => {
  it("keeps a title that is not taken", () => {
    expect(uniqueTitle("Alpha", ["Beta"])).toBe("Alpha");
  });

  it("appends a counter when taken", () => {
    expect(uniqueTitle("Alpha", ["Alpha"])).toBe("Alpha 2");
  });

  it("skips past existing counters", () => {
    expect(uniqueTitle("Alpha", ["Alpha", "Alpha 2", "Alpha 3"])).toBe("Alpha 4");
  });

  it("compares case- and trim-insensitively, matching buildGraph", () => {
    expect(uniqueTitle("Alpha", ["  alpha "])).toBe("Alpha 2");
  });

  it("handles an empty taken list", () => {
    expect(uniqueTitle("Alpha", [])).toBe("Alpha");
  });
});
