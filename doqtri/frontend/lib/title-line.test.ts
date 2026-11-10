import { describe, expect, it } from "vitest";
import { mindmapFromHeadings } from "@/lib/mindmap-types";
import { withTitleLine } from "@/lib/title-line";
import { rewriteTitleHeading } from "@/lib/title-heading";

const BODY = "\n\n## Scope\n\nText.";

describe("withTitleLine (D-120)", () => {
  it("adds nothing to a note that opens with its title line, however often it is opened", () => {
    for (const markdown of [`# Plan${BODY}`, `#   plan  ${BODY}`, `# [[Plan]]${BODY}`, `# [[Target|Plan]]${BODY}`, "# Plan"]) {
      expect(withTitleLine(markdown, "Plan", "open"), markdown).toBeNull();
    }
    const added = withTitleLine(`Prose${BODY}`, "Plan", "open")!;
    expect(withTitleLine(added, "Plan", "open")).toBeNull();
  });

  it("puts `# <title>` above a note that opens with something else, which moves down untouched", () => {
    expect(withTitleLine(`Some prose.${BODY}`, "Plan", "open")).toBe(`# Plan\n\nSome prose.${BODY}`);
    expect(withTitleLine(`## Plan${BODY}`, "Plan", "open")).toBe(`# Plan\n\n## Plan${BODY}`);
    expect(withTitleLine(`# Other${BODY}`, "Plan", "open")).toBe(`# Plan\n\n# Other${BODY}`);
    expect(withTitleLine("- [ ] todo", "Plan", "open")).toBe("# Plan\n\n- [ ] todo");
  });

  it("folds the blank lines a note opens with into the one under the title", () => {
    expect(withTitleLine(`\n\n  \nSome prose.${BODY}`, "Plan", "open")).toBe(`# Plan\n\nSome prose.${BODY}`);
    // Already the title, after blank lines: they go, so it is line 1.
    expect(withTitleLine(`\n \n# Plan${BODY}`, "Plan", "open")).toBe(`# Plan${BODY}`);
  });

  it("fills an empty heading rather than pushing it down", () => {
    expect(withTitleLine(`# ${BODY}`, "Plan", "open")).toBe(`# Plan${BODY}`);
    expect(withTitleLine(`#${BODY}`, "Plan", "open")).toBe(`# Plan${BODY}`);
    expect(withTitleLine(`\n#   ${BODY}`, "Plan", "open")).toBe(`# Plan${BODY}`);
  });

  it("gives an empty note just its title line", () => {
    expect(withTitleLine("", "Plan", "open")).toBe("# Plan");
    expect(withTitleLine("\n \n", "Plan", "open")).toBe("# Plan");
  });

  it("keeps CRLF text CRLF", () => {
    expect(withTitleLine("Prose\r\nMore\r\n", "Plan", "open")).toBe("# Plan\r\n\r\nProse\r\nMore\r\n");
    expect(withTitleLine("\r\n# Plan\r\nBody", "Plan", "open")).toBe("# Plan\r\nBody");
  });

  it("writes the title trimmed, and nothing for a title no note can have", () => {
    expect(withTitleLine("Prose", "  Plan  ", "open")).toBe("# Plan\n\nProse");
    expect(withTitleLine("Prose", "   ", "open")).toBeNull();
    expect(withTitleLine("Prose", "Two\nlines", "open")).toBeNull();
  });

  it("on a reload, takes any level-1 heading as the title line, so a heading renamed elsewhere is not pushed down", () => {
    expect(withTitleLine(`# Renamed elsewhere${BODY}`, "Plan", "reload")).toBeNull();
    expect(withTitleLine(`\n# Renamed elsewhere${BODY}`, "Plan", "reload")).toBe(`# Renamed elsewhere${BODY}`);
    // Anything else still gets one.
    expect(withTitleLine(`Regenerated prose${BODY}`, "Plan", "reload")).toBe(`# Plan\n\nRegenerated prose${BODY}`);
    expect(withTitleLine(`## Section${BODY}`, "Plan", "reload")).toBe(`# Plan\n\n## Section${BODY}`);
    expect(withTitleLine(`# ${BODY}`, "Plan", "reload")).toBe(`# Plan${BODY}`);
  });

  it("leaves the mindmap folding the title into its root, with no lone heading node (DOQ-30)", () => {
    for (const legacy of [`Prose${BODY}`, `## Scope\n\nText.`, `\n\n## Scope`]) {
      const normalised = withTitleLine(legacy, "Plan", "open")!;
      const map = mindmapFromHeadings("Plan", normalised);
      expect(map.root.label).toBe("Plan");
      expect(map.root.children.map((child) => child.label)).toEqual(["Scope"]);
    }
  });

  it("is what a rename from the explorer leaves a never-opened older note to (DOQ-35)", () => {
    // The server leaves text that does not open with the old title alone...
    const legacy = `Some prose.${BODY}`;
    expect(rewriteTitleHeading(legacy, "Old", "New")).toBeNull();
    // ...and the next editable open writes the new title above it.
    expect(withTitleLine(legacy, "New", "open")).toBe(`# New\n\nSome prose.${BODY}`);
  });
});
