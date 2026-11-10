import { describe, expect, it } from "vitest";
import { mindmapFromHeadings } from "@/lib/mindmap-types";
import { deriveTitle } from "@/lib/title";
import { rewriteTitleHeading } from "@/lib/title-heading";

describe("rewriteTitleHeading (DOQ-35)", () => {
  it("renames a first-line heading that matches the old title", () => {
    expect(rewriteTitleHeading("# Old\n\n## Scope\n\nBody.\n", "Old", "New")).toBe(
      "# New\n\n## Scope\n\nBody.\n",
    );
  });

  it("ignores case and spacing in the heading, as titles are compared", () => {
    expect(rewriteTitleHeading("#   old   TITLE  \nBody", "Old Title", "New")).toBe("# New\nBody");
    expect(rewriteTitleHeading("#\tOld  Title\nBody", "  old title ", "New")).toBe("# New\nBody");
  });

  it("follows a rename that only changes case", () => {
    expect(rewriteTitleHeading("# roadmap\n", "roadmap", "Roadmap")).toBe("# Roadmap\n");
  });

  it("drops closing # marks along with the old heading", () => {
    expect(rewriteTitleHeading("# Old #\nBody", "Old", "New")).toBe("# New\nBody");
    expect(rewriteTitleHeading("# Old ###   \nBody", "Old", "New")).toBe("# New\nBody");
  });

  it("writes exactly '# <title>', as rename_document() checks", () => {
    expect(rewriteTitleHeading("# Old\n", "Old", "Take #")).toBe("# Take #\n");
    expect(rewriteTitleHeading("# Old\n", "Old", "C#")).toBe("# C#\n");
  });

  it("counts the same lines as blank as the database does", () => {
    // A no-break space is not blank to title_heading_rewrite(), so it is the
    // first line here too, and the rename leaves the text alone.
    expect(rewriteTitleHeading("\u00a0\n# Old\n", "Old", "New")).toBeNull();
    expect(rewriteTitleHeading("\f\v \t\n# Old\n", "Old", "New")).toBe("\f\v \t\n# New\n");
  });

  it("skips blank lines before the heading and keeps them", () => {
    expect(rewriteTitleHeading("\n  \n# Old\nBody", "Old", "New")).toBe("\n  \n# New\nBody");
  });

  it("keeps CRLF line endings", () => {
    expect(rewriteTitleHeading("# Old\r\n\r\n## Scope\r\nBody\r\n", "Old", "New")).toBe(
      "# New\r\n\r\n## Scope\r\nBody\r\n",
    );
    expect(rewriteTitleHeading("\r\n# Old #\r\nBody", "Old", "New")).toBe("\r\n# New\r\nBody");
  });

  it("works on a note that is only the heading", () => {
    expect(rewriteTitleHeading("# Old", "Old", "New")).toBe("# New");
  });

  it("leaves a different heading alone", () => {
    expect(rewriteTitleHeading("# Something else\n\nBody", "Old", "New")).toBeNull();
    expect(rewriteTitleHeading("# Old plan\n", "Old", "New")).toBeNull();
  });

  it("leaves a note with no heading alone", () => {
    expect(rewriteTitleHeading("Just prose about Old.\n", "Old", "New")).toBeNull();
    expect(rewriteTitleHeading("", "Old", "New")).toBeNull();
    expect(rewriteTitleHeading("\n\n", "Old", "New")).toBeNull();
  });

  it("leaves the title heading alone when it is not the first non-blank line", () => {
    expect(rewriteTitleHeading("Intro line\n# Old\n", "Old", "New")).toBeNull();
    expect(rewriteTitleHeading("## Old\n", "Old", "New")).toBeNull();
    expect(rewriteTitleHeading("#Old\n", "Old", "New")).toBeNull();
    expect(rewriteTitleHeading("  # Old\n", "Old", "New")).toBeNull();
  });

  it("reads a wikilink heading as the mindmap does, and writes a plain one", () => {
    // cleanLabel and deriveTitle read `# [[Old]]` as "Old" ...
    expect(rewriteTitleHeading("# [[Old]]\nBody", "Old", "New")).toBe("# New\nBody");
    // ... and `# [[Old|Alias]]` as its alias, so that is the title it heads.
    expect(rewriteTitleHeading("# [[Old|Alias]]\nBody", "Old", "New")).toBeNull();
    expect(rewriteTitleHeading("# [[Old|Alias]]\nBody", "Alias", "New")).toBe("# New\nBody");
    expect(rewriteTitleHeading("# [[old]] #\r\nBody", "Old", "New")).toBe("# New\r\nBody");
  });

  it("agrees with deriveTitle on which title a wikilink heading names", () => {
    for (const heading of ["# [[Old]]", "# [[Old|Alias]]", "# [[Old]] plan", "# Old"]) {
      const title = deriveTitle(`${heading}\n`, "x.md");
      expect(rewriteTitleHeading(`${heading}\n`, title, "New"), heading).toBe("# New\n");
    }
  });

  it("writes nothing for a new title that is not one line", () => {
    expect(rewriteTitleHeading("# Old\n## Scope\n", "Old", "New\n## Injected")).toBeNull();
    expect(rewriteTitleHeading("# Old\n", "Old", "New\r## X")).toBeNull();
    expect(rewriteTitleHeading("# Old\n", "Old", "Tab\there")).toBeNull();
  });

  it("answers null when the heading already reads as the new title", () => {
    expect(rewriteTitleHeading("# New\n", "New", "New")).toBeNull();
  });

  it("keeps the mindmap folded: sections sit directly around the renamed root", () => {
    const before = "# Old\n\n## Scope\n\n## Risks\n";
    const after = rewriteTitleHeading(before, "Old", "New");
    expect(after).not.toBeNull();
    const tree = mindmapFromHeadings("New", after!);
    expect(tree.root.label).toBe("New");
    expect(tree.root.children.map((node) => node.label)).toEqual(["Scope", "Risks"]);
    // Without the rewrite the old heading is a lone child of the new root.
    expect(mindmapFromHeadings("New", before).root.children.map((node) => node.label)).toEqual(["Old"]);
  });
});
