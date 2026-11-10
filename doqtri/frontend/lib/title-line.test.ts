import { describe, expect, it } from "vitest";
import { mindmapFromHeadings } from "@/lib/mindmap-types";
import { hasTitleLine, titleLineEdit, withTitleLine } from "@/lib/title-line";
import { rewriteTitleHeading } from "@/lib/title-heading";

const BODY = "\n\n## Scope\n\nText.";

describe("withTitleLine (D-120)", () => {
  it("adds nothing to a note that opens with its title line, however often it is edited", () => {
    for (const markdown of [`# Plan${BODY}`, `#   plan  ${BODY}`, `# [[Plan]]${BODY}`, `# [[Target|Plan]]${BODY}`, "# Plan", `# ${BODY}`]) {
      expect(withTitleLine(markdown, "Plan"), markdown).toBeNull();
    }
    const added = withTitleLine(`Prose${BODY}`, "Plan")!;
    expect(withTitleLine(added, "Plan")).toBeNull();
  });

  it("puts `# <title>` above a note that opens with anything else, which stays as it is", () => {
    expect(withTitleLine(`Some prose.${BODY}`, "Plan")).toBe(`# Plan\n\nSome prose.${BODY}`);
    expect(withTitleLine(`## Plan${BODY}`, "Plan")).toBe(`# Plan\n\n## Plan${BODY}`);
    expect(withTitleLine("- [ ] todo", "Plan")).toBe("# Plan\n\n- [ ] todo");
    expect(withTitleLine("Intro\n# Plan\n## A", "Plan")).toBe("# Plan\n\nIntro\n# Plan\n## A");
    // A heading that says something else is the note's own content: an
    // older opening section, or one a refused rename left behind.
    expect(withTitleLine(`# Introduction${BODY}`, "Physics")).toBe(`# Physics\n\n# Introduction${BODY}`);
    // A `#` with no space is not a title line either.
    expect(withTitleLine(`#${BODY}`, "Plan")).toBe(`# Plan\n\n#${BODY}`);
  });

  it("knows its own title line by its raw text too, so titles with # or links get no second line", () => {
    for (const title of ["Week #", "C# ##", "About [[Foo]]", "[[A|B]]", "Take #", "  Week #  "]) {
      const line = `# ${title.trim()}${BODY}`;
      expect(withTitleLine(line, title), title).toBeNull();
      expect(hasTitleLine(line, title), title).toBe(true);
      const added = withTitleLine(`Prose${BODY}`, title)!;
      expect(added).toBe(`# ${title.trim()}\n\nProse${BODY}`);
      expect(withTitleLine(added, title), title).toBeNull();
    }
  });

  it("is always a plain insert at the start ending in a line break, leaving blank lines where they are", () => {
    expect(titleLineEdit(`Prose${BODY}`, "Plan")).toEqual({ from: 0, to: 0, insert: "# Plan\n\n" });
    expect(titleLineEdit("\n\nProse", "Plan")).toEqual({ from: 0, to: 0, insert: "# Plan\n" });
    expect(titleLineEdit("", "Plan")).toEqual({ from: 0, to: 0, insert: "# Plan\n" });
    expect(withTitleLine("\n\nProse", "Plan")).toBe("# Plan\n\n\nProse");
    expect(titleLineEdit(`# Plan${BODY}`, "Plan")).toBeNull();
    // A title line after blank lines is the note's title line: nothing is added.
    expect(titleLineEdit(`\n \n# Plan${BODY}`, "Plan")).toBeNull();
  });

  it("keeps CRLF text CRLF", () => {
    expect(withTitleLine("Prose\r\nMore\r\n", "Plan")).toBe("# Plan\r\n\r\nProse\r\nMore\r\n");
    expect(withTitleLine("\r\nBody", "Plan")).toBe("# Plan\r\n\r\nBody");
  });

  it("writes the title trimmed, and nothing for a title no note can have", () => {
    expect(withTitleLine("Prose", "  Plan  ")).toBe("# Plan\n\nProse");
    expect(withTitleLine("Prose", "   ")).toBeNull();
    expect(withTitleLine("Prose", "Two\nlines")).toBeNull();
  });

  it("leaves the mindmap folding the title into its root, with no lone title node (DOQ-30)", () => {
    for (const legacy of [`Prose${BODY}`, `## Scope\n\nText.`, `\n\n## Scope`]) {
      const map = mindmapFromHeadings("Plan", withTitleLine(legacy, "Plan")!);
      expect(map.root.label).toBe("Plan");
      expect(map.root.children.map((child) => child.label)).toEqual(["Scope"]);
    }
    // An older opening heading stays a section beside the root's others.
    const map = mindmapFromHeadings("Plan", withTitleLine(`# Other${BODY}`, "Plan")!);
    expect(map.root.children.map((child) => child.label)).toEqual(["Other"]);
    expect(map.root.children[0].children.map((child) => child.label)).toEqual(["Scope"]);
  });

  it("is what a rename from the explorer leaves a never-edited older note to (DOQ-35)", () => {
    const legacy = `Some prose.${BODY}`;
    expect(rewriteTitleHeading(legacy, "Old", "New")).toBeNull();
    expect(withTitleLine(legacy, "New")).toBe(`# New\n\nSome prose.${BODY}`);
  });
});
