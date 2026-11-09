import { describe, expect, it } from "vitest";
import { adoptRename } from "@/lib/rename-adopt";

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
