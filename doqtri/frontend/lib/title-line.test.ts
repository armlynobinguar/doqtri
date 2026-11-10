import { describe, expect, it } from "vitest";
import { mindmapFromHeadings } from "@/lib/mindmap-types";
import { hasTitleLine, titleLineEdit, withTitleLine } from "@/lib/title-line";
import { rewriteTitleHeading } from "@/lib/title-heading";

const BODY = "\n\n## Scope\n\nText.";

describe("withTitleLine (D-120)", () => {
  it("adds nothing to a note that opens with its title line, however often it is edited", () => {
    for (const markdown of [`# Plan${BODY}`, `#   plan  ${BODY}`, `# [[Plan]]${BODY}`, `# [[Target|Plan]]${BODY}`, "# Plan"]) {
      expect(withTitleLine(markdown, "Plan"), markdown).toBeNull();
    }
    const added = withTitleLine(`Prose${BODY}`, "Plan")!;
    expect(withTitleLine(added, "Plan")).toBeNull();
  });

  it("puts `# <title>` above a note that opens with something else, which moves down untouched", () => {
    expect(withTitleLine(`Some prose.${BODY}`, "Plan")).toBe(`# Plan\n\nSome prose.${BODY}`);
    expect(withTitleLine(`## Plan${BODY}`, "Plan")).toBe(`# Plan\n\n## Plan${BODY}`);
    expect(withTitleLine("- [ ] todo", "Plan")).toBe("# Plan\n\n- [ ] todo");
    expect(withTitleLine("Intro\n# Plan\n## A", "Plan")).toBe("# Plan\n\nIntro\n# Plan\n## A");
  });

  it("keeps a level-1 heading the note already opens with as its title line, whatever it says", () => {
    // Typed by the student, left by a refused rename (TITLE_TAKEN), or written by a Regenerate.
    for (const markdown of [`# Something I wrote${BODY}`, `# Taken elsewhere${BODY}`, `# [[Other]]${BODY}`]) {
      expect(withTitleLine(markdown, "Plan"), markdown).toBeNull();
      expect(hasTitleLine(markdown, "Plan")).toBe(true);
    }
  });

  it("knows its own title line by its raw text too, so titles with # or links get no second line", () => {
    for (const title of ["Week #", "C# ##", "About [[Foo]]", "[[A|B]]", "##", "Take #", "  Week #  "]) {
      const line = `# ${title.trim()}${BODY}`;
      expect(withTitleLine(line, title), title).toBeNull();
      expect(hasTitleLine(line, title), title).toBe(true);
      // Added once, then never again.
      const added = withTitleLine(`Prose${BODY}`, title)!;
      expect(added).toBe(`# ${title.trim()}\n\nProse${BODY}`);
      expect(withTitleLine(added, title), title).toBeNull();
    }
  });

  it("folds the blank lines a note opens with into the one under the title", () => {
    expect(withTitleLine(`\n\n  \nSome prose.${BODY}`, "Plan")).toBe(`# Plan\n\nSome prose.${BODY}`);
    // Already a title line, after blank lines: they go, so it is line 1.
    expect(withTitleLine(`\n \n# Plan${BODY}`, "Plan")).toBe(`# Plan${BODY}`);
  });

  it("fills an empty heading rather than pushing it down", () => {
    expect(withTitleLine(`# ${BODY}`, "Plan")).toBe(`# Plan${BODY}`);
    expect(withTitleLine(`#${BODY}`, "Plan")).toBe(`# Plan${BODY}`);
    expect(withTitleLine(`\n#   ${BODY}`, "Plan")).toBe(`# Plan${BODY}`);
  });

  it("gives an empty note just its title line", () => {
    expect(withTitleLine("", "Plan")).toBe("# Plan");
    expect(withTitleLine("\n \n", "Plan")).toBe("# Plan");
  });

  it("keeps CRLF text CRLF", () => {
    expect(withTitleLine("Prose\r\nMore\r\n", "Plan")).toBe("# Plan\r\n\r\nProse\r\nMore\r\n");
    expect(withTitleLine("\r\n# Plan\r\nBody", "Plan")).toBe("# Plan\r\nBody");
  });

  it("writes the title trimmed, and nothing for a title no note can have", () => {
    expect(withTitleLine("Prose", "  Plan  ")).toBe("# Plan\n\nProse");
    expect(withTitleLine("Prose", "   ")).toBeNull();
    expect(withTitleLine("Prose", "Two\nlines")).toBeNull();
  });

  it("says where the change goes: always at the top, so an edit made below it stays where it was made", () => {
    expect(titleLineEdit(`Prose${BODY}`, "Plan")).toEqual({ from: 0, to: 0, insert: "# Plan\n\n" });
    expect(titleLineEdit(`\n\nProse`, "Plan")).toEqual({ from: 0, to: 2, insert: "# Plan\n\n" });
    expect(titleLineEdit(`# ${BODY}`, "Plan")).toEqual({ from: 0, to: 2, insert: "# Plan" });
    expect(titleLineEdit(`# Plan${BODY}`, "Plan")).toBeNull();
  });

  it("leaves the mindmap folding the title into its root, with no lone heading node (DOQ-30)", () => {
    for (const legacy of [`Prose${BODY}`, `## Scope\n\nText.`, `\n\n## Scope`]) {
      const normalised = withTitleLine(legacy, "Plan")!;
      const map = mindmapFromHeadings("Plan", normalised);
      expect(map.root.label).toBe("Plan");
      expect(map.root.children.map((child) => child.label)).toEqual(["Scope"]);
    }
  });

  it("is what a rename from the explorer leaves a never-edited older note to (DOQ-35)", () => {
    // The server leaves text that does not open with the old title alone...
    const legacy = `Some prose.${BODY}`;
    expect(rewriteTitleHeading(legacy, "Old", "New")).toBeNull();
    // ...and the next edit writes the new title above it.
    expect(withTitleLine(legacy, "New")).toBe(`# New\n\nSome prose.${BODY}`);
  });
});
