import { describe, expect, it } from "vitest";
import {
  decideHeadingRename,
  headingNoticeText,
  movesBaseline,
  opensWithTitle,
  readFirstLine,
} from "@/lib/heading-rename";
import { MAX_TITLE_LENGTH } from "@/lib/title";

const BODY = "\n\n## Scope\n\nText.";
const note = (heading: string) => `${heading}${BODY}`;

describe("decideHeadingRename", () => {
  it("renames when the title heading changed to a valid title", () => {
    expect(decideHeadingRename(note("# Plan"), note("# Roadmap"), "Plan")).toEqual({ rename: true, title: "Roadmap" });
  });

  it("matches the title before the edit as titles compare, ignoring case and spacing", () => {
    expect(decideHeadingRename(note("#   plan  "), note("# Roadmap"), "Plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
    expect(decideHeadingRename(note("# Big   Plan"), note("# Roadmap"), "big plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
  });

  it("trims the new title and drops closing hashes, as the server would store it", () => {
    expect(decideHeadingRename(note("# Plan"), note("#  Roadmap   ##"), "Plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
  });

  it("reads the first non-blank line, past blank lines", () => {
    expect(decideHeadingRename(`\n  \n# Plan${BODY}`, `\n\t\n# Roadmap${BODY}`, "Plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
  });

  it("reads wikilink headings the way the mindmap does", () => {
    expect(decideHeadingRename(note("# [[Plan]]"), note("# [[Roadmap]]"), "Plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
    expect(decideHeadingRename(note("# [[Target|Plan]]"), note("# [[Target|Roadmap]]"), "Plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
    expect(decideHeadingRename(note("# Plan"), note("# [[Roadmap]]"), "Plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
    // `# [[Plan|Alias]]` says Alias, so it is not the heading of "Plan".
    expect(decideHeadingRename(note("# [[Plan|Alias]]"), note("# Roadmap"), "Plan")).toEqual({
      rename: false,
      reason: "not-title-heading",
    });
  });

  it("reads CRLF text, with the \\r outside the heading", () => {
    const crlf = (heading: string) => `${heading}\r\n\r\n## Scope\r\n`;
    expect(decideHeadingRename(crlf("# Plan"), crlf("# Roadmap"), "Plan")).toEqual({ rename: true, title: "Roadmap" });
    expect(decideHeadingRename(`\r\n${crlf("# Plan")}`, `\r\n${crlf("# Roadmap")}`, "Plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
    expect(decideHeadingRename(crlf("# Plan"), crlf("# Plan"), "Plan")).toEqual({ rename: false, reason: "unchanged" });
  });

  it("applies the same rule to a pasted note's first line", () => {
    expect(decideHeadingRename(note("# Plan"), "# Pasted Note\n\nAll new.", "Plan")).toEqual({
      rename: true,
      title: "Pasted Note",
    });
    expect(decideHeadingRename(note("# Plan"), "All new prose.", "Plan")).toEqual({
      rename: false,
      reason: "not-heading",
    });
  });

  it("renames back on undo, by the same rule", () => {
    expect(decideHeadingRename(note("# Roadmap"), note("# Plan"), "Roadmap")).toEqual({ rename: true, title: "Plan" });
  });

  describe("does not rename", () => {
    it("a heading that did not say the title before the edit", () => {
      expect(decideHeadingRename(note("# Something I wrote"), note("# Roadmap"), "Plan")).toEqual({
        rename: false,
        reason: "not-title-heading",
      });
    });

    it("a note whose first line was not a level-1 heading", () => {
      for (const before of [note("## Plan"), "Plan\n\n# Plan", "# Intro\n\n# Plan", "", "#Plan"]) {
        expect(decideHeadingRename(before, note("# Roadmap"), "Plan")).toEqual({
          rename: false,
          reason: "not-title-heading",
        });
      }
    });

    it("a heading that still says the title", () => {
      expect(decideHeadingRename(note("# Plan"), note("# Plan"), "Plan")).toEqual({ rename: false, reason: "unchanged" });
      expect(decideHeadingRename(note("# Plan"), `${note("# Plan")} more text`, "Plan")).toEqual({
        rename: false,
        reason: "unchanged",
      });
    });

    it("a change of case or spacing only", () => {
      expect(decideHeadingRename(note("# Big Plan"), note("# big   PLAN"), "Big Plan")).toEqual({
        rename: false,
        reason: "unchanged",
      });
      expect(decideHeadingRename(note("# Plan"), note("# [[plan]]"), "Plan")).toEqual({
        rename: false,
        reason: "unchanged",
      });
    });

    it("a deleted or emptied heading", () => {
      for (const after of [note("# "), note("#"), note("#   "), "", "\n\n  \n"]) {
        expect(decideHeadingRename(note("# Plan"), after, "Plan")).toEqual({ rename: false, reason: "emptied" });
      }
    });

    it("a first line that stops being a # heading", () => {
      for (const after of [note("## Roadmap"), note("Roadmap"), note("#Roadmap"), `## Scope\n\nText.`, note("- Roadmap")]) {
        expect(decideHeadingRename(note("# Plan"), after, "Plan")).toEqual({ rename: false, reason: "not-heading" });
      }
    });

    it("a title with control characters", () => {
      expect(decideHeadingRename(note("# Plan"), note("# Road\tmap"), "Plan")).toEqual({
        rename: false,
        reason: "invalid-title",
      });
      expect(decideHeadingRename(note("# Plan"), note("# Road\u0007map"), "Plan")).toEqual({
        rename: false,
        reason: "invalid-title",
      });
    });

    it("a title over the length limit", () => {
      const longest = "R".repeat(MAX_TITLE_LENGTH);
      expect(decideHeadingRename(note("# Plan"), note(`# ${longest}`), "Plan")).toEqual({
        rename: true,
        title: longest,
      });
      expect(decideHeadingRename(note("# Plan"), note(`# ${longest}R`), "Plan")).toEqual({
        rename: false,
        reason: "invalid-title",
      });
    });
  });
});

describe("movesBaseline", () => {
  it("keeps the text from before while the heading is being retyped", () => {
    expect(movesBaseline("emptied")).toBe(false);
    expect(movesBaseline("invalid-title")).toBe(false);
  });

  it("moves on once the first line is something definite", () => {
    expect(movesBaseline("unchanged")).toBe(true);
    expect(movesBaseline("not-title-heading")).toBe(true);
    expect(movesBaseline("not-heading")).toBe(true);
  });
});

describe("readFirstLine and opensWithTitle", () => {
  it("tells a blank note, an empty heading, a heading and anything else apart", () => {
    expect(readFirstLine(" \n\t\n")).toEqual({ kind: "blank" });
    expect(readFirstLine("#\nText")).toEqual({ kind: "empty-heading" });
    expect(readFirstLine("# [[Plan|Alias]] #\n")).toEqual({ kind: "heading", label: "Alias" });
    expect(readFirstLine("## Plan")).toEqual({ kind: "other" });
  });

  it("says whether the note opens with its title heading", () => {
    expect(opensWithTitle("# plan\r\n", "Plan")).toBe(true);
    expect(opensWithTitle("Intro\n# Plan", "Plan")).toBe(false);
    expect(opensWithTitle("# Plan", "")).toBe(false);
  });
});

describe("headingNoticeText", () => {
  it("says why a clashing heading did not rename the note, and what to do", () => {
    expect(headingNoticeText({ kind: "clash", heading: "Roadmap", title: "Plan" })).toEqual({
      message: "Another note is already called “Roadmap”. The title stays “Plan”.",
      hint: "Edit the heading, or rename the note from the explorer.",
    });
  });

  it("counts the notes still linking to the old title", () => {
    expect(
      headingNoticeText({ kind: "renamed", title: "Roadmap", previousTitle: "Plan", backlinks: 3 }).message,
    ).toBe("Renamed to “Roadmap”. 3 notes still link to “Plan”.");
    expect(
      headingNoticeText({ kind: "renamed", title: "Roadmap", previousTitle: "Plan", backlinks: 1 }).message,
    ).toBe("Renamed to “Roadmap”. 1 note still links to “Plan”.");
  });
});
