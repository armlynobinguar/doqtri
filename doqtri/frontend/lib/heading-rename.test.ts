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
    // `# [[Plan|Alias]]` says Alias: changing it to Roadmap is a change.
    expect(decideHeadingRename(note("# [[Plan|Alias]]"), note("# Roadmap"), "Plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
    // And `# [[Roadmap|Plan]]` still says the title.
    expect(decideHeadingRename(note("# Plan"), note("# [[Roadmap|Plan]]"), "Plan")).toEqual({
      rename: false,
      reason: "unchanged",
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

  it("renames when the title line itself is edited into a later heading's text", () => {
    // One more `# Second part` than before: the first line was typed, not moved up.
    expect(decideHeadingRename("# Old\n\n# Second part\n", "# Second part\n\n# Second part\n", "Old")).toEqual({
      rename: true,
      title: "Second part",
    });
    // A later heading that merely says the same thing differently is another line.
    expect(decideHeadingRename("# Old\n\n#  Second part\n", "# Second part\n\n#  Second part\n", "Old")).toEqual({
      rename: true,
      title: "Second part",
    });
  });

  it("renames whatever the first line said before the edit, since it is the title line (D-120)", () => {
    // A note whose title line was added above an older heading, or one that
    // never said the title: editing the first line is editing the title.
    expect(decideHeadingRename(note("# Something I wrote"), note("# Roadmap"), "Plan")).toEqual({
      rename: true,
      title: "Roadmap",
    });
    for (const before of [note("## Plan"), "Plan\n\n# Plan", "# Intro\n\n# Plan", "", "#Plan", note("# ")]) {
      expect(decideHeadingRename(before, note("# Roadmap"), "Plan"), before).toEqual({ rename: true, title: "Roadmap" });
    }
  });

  it("renames back on undo, by the same rule", () => {
    expect(decideHeadingRename(note("# Roadmap"), note("# Plan"), "Roadmap")).toEqual({ rename: true, title: "Plan" });
  });

  describe("does not rename", () => {
    it("a heading that differs from the title but was not edited", () => {
      // Loaded that way, or left by a rename made elsewhere (TITLE_CHANGED):
      // it renames once someone edits it, not before.
      expect(decideHeadingRename(note("# Something I wrote"), note("# Something I wrote"), "Plan")).toEqual({
        rename: false,
        reason: "unchanged",
      });
      expect(decideHeadingRename(note("# Theirs"), `${note("#  theirs ")} more text`, "Plan")).toEqual({
        rename: false,
        reason: "unchanged",
      });
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
