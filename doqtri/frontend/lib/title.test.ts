import { describe, expect, it } from "vitest";
import { deriveTitle, hasControlCharacters, isTitleTaken, renameRefusal, TITLE_ONE_LINE, uniqueTitle } from "@/lib/title";

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

describe("isTitleTaken", () => {
  it("matches case- and trim-insensitively", () => {
    expect(isTitleTaken("  plan ", ["Plan"])).toBe(true);
  });

  it("is false when nothing matches", () => {
    expect(isTitleTaken("Plan", ["Plans", "Other"])).toBe(false);
  });
});

describe("hasControlCharacters (DOQ-35)", () => {
  it("finds line breaks, tabs and other control characters", () => {
    for (const title of ["a\nb", "a\rb", "a\tb", "\u0000", "a\u001fb", "a\u007f"]) {
      expect(hasControlCharacters(title), JSON.stringify(title)).toBe(true);
    }
  });

  it("passes ordinary titles, accents and emoji included", () => {
    for (const title of ["Roadmap 2027", "C# notes", "Café — plan", "Launch 🚀", "[[Linked]]"]) {
      expect(hasControlCharacters(title), title).toBe(false);
    }
  });
});

describe("renameRefusal", () => {
  it("refuses a title that is not one line, before anything else, with the route's wording", () => {
    for (const title of ["New\n## X", "Tab\there", "Del\u007f"]) {
      expect(renameRefusal(title, [])).toBe(TITLE_ONE_LINE);
    }
  });

  it("refuses a title another note has, ignoring case and spacing", () => {
    expect(renameRefusal("plan ", ["Plan"])).toBe("Another note is already called “plan ”");
  });

  it("allows anything else", () => {
    expect(renameRefusal("Roadmap", ["Plan"])).toBeNull();
  });
});
