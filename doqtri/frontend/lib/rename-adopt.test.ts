import { describe, expect, it } from "vitest";
import { adoptRename, titleLineAfterRename } from "@/lib/rename-adopt";

const renamed = {
  title: "New",
  previousTitle: "Old",
  markdown: "# New\n\nBody.\n",
  version: 4,
  previousVersion: 3,
};

describe("adoptRename (DOQ-35)", () => {
  it("adopts the server's text and version when the editor is at the version it replaced", () => {
    expect(adoptRename({ renamed, editorVersion: 3, saved: "# Old\n\nBody.\n", current: "# Old\n\nBody.\n" })).toEqual({
      version: 4,
      saved: "# New\n\nBody.\n",
      text: "# New\n\nBody.\n",
    });
  });

  it("keeps text typed since the last save, with the same heading change", () => {
    expect(
      adoptRename({ renamed, editorVersion: 3, saved: "# Old\n\nBody.\n", current: "# Old\n\nBody. Typed.\n" }),
    ).toEqual({ version: 4, saved: "# New\n\nBody.\n", text: "# New\n\nBody. Typed.\n" });
  });

  it("keeps typed text as it is when the user rewrote the heading themselves", () => {
    expect(
      adoptRename({ renamed, editorVersion: 3, saved: "# Old\n\nBody.\n", current: "# Mine\n\nBody.\n" }),
    ).toEqual({ version: 4, saved: "# New\n\nBody.\n", text: "# Mine\n\nBody.\n" });
  });

  it("takes nothing when the editor's copy was already behind the note", () => {
    // Saved elsewhere at version 3 while this editor still holds version 2,
    // with an unsaved edit: adopting would drop the edit and hide the
    // conflict its next save will report.
    expect(
      adoptRename({ renamed, editorVersion: 2, saved: "# Old\n\nOlder.\n", current: "# Old\n\nOlder. Typed.\n" }),
    ).toBeNull();
    expect(adoptRename({ renamed, editorVersion: 5, saved: "x", current: "x" })).toBeNull();
  });

  it("takes nothing from a title-only rename", () => {
    expect(
      adoptRename({ renamed: { title: "New", previousTitle: "Old" }, editorVersion: 3, saved: "a", current: "b" }),
    ).toBeNull();
  });
});

describe("titleLineAfterRename (DOQ-46)", () => {
  const titleOnly = { title: "No titlesdffga", previousTitle: "No title" };

  it("rewrites a held line 1 the server left alone, after the safety check", () => {
    // The prod drift: line 1 retyped to `# No titl`, then renamed from the explorer.
    expect(titleLineAfterRename({ renamed: titleOnly, text: "# No titl\n\n## Scope\n", held: true })).toEqual({
      kind: "rewrite",
      text: "# No titlesdffga\n\n## Scope\n",
      check: true,
    });
  });

  it("heals a line 1 an older rename left behind, and an emptied one", () => {
    expect(titleLineAfterRename({ renamed: titleOnly, text: "# No title", held: true })).toEqual({
      kind: "rewrite",
      text: "# No titlesdffga",
      check: true,
    });
    expect(titleLineAfterRename({ renamed: titleOnly, text: "# \nBody.", held: true })).toEqual({
      kind: "rewrite",
      text: "# No titlesdffga\nBody.",
      check: true,
    });
  });

  it("keeps the line ending and every other byte", () => {
    expect(titleLineAfterRename({ renamed: titleOnly, text: "# Old\r\n\r\nBody.\r\n", held: true })).toEqual({
      kind: "rewrite",
      text: "# No titlesdffga\r\n\r\nBody.\r\n",
      check: true,
    });
  });

  it("needs no safety check when the server wrote that line itself", () => {
    // adoptRename took nothing (the copy was behind), but the stored note has the new line.
    expect(titleLineAfterRename({ renamed, text: "# Old\n\nBody.\n", held: true })).toEqual({
      kind: "rewrite",
      text: "# New\n\nBody.\n",
      check: false,
    });
  });

  it("leaves a line 1 the guard does not hold: the student's own heading", () => {
    expect(titleLineAfterRename({ renamed: titleOnly, text: "# Introduction\n\nBody.", held: false })).toEqual({
      kind: "keep",
    });
  });

  it("leaves a line 1 that already says the new title, or is not a heading", () => {
    expect(titleLineAfterRename({ renamed: titleOnly, text: "# No titlesdffga\n", held: true })).toEqual({ kind: "keep" });
    expect(titleLineAfterRename({ renamed: titleOnly, text: "#  no TITLESDFFGA\n", held: true })).toEqual({ kind: "keep" });
    expect(titleLineAfterRename({ renamed: titleOnly, text: "Prose\n", held: true })).toEqual({ kind: "keep" });
  });

  it("writes no title that is not one line", () => {
    expect(
      titleLineAfterRename({ renamed: { title: "Two\nlines", previousTitle: "Old" }, text: "# Old\n", held: true }),
    ).toEqual({ kind: "keep" });
  });
});
