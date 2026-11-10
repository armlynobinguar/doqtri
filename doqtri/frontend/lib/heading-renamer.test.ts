import { describe, expect, it, vi } from "vitest";
import { createHeadingRenamer, type HeadingCheck } from "@/lib/heading-renamer";
import { RenameError, type RenamedNote } from "@/lib/rename-note";

const BODY = "\n\n## Scope\n\nBody.";
const note = (heading: string) => `# ${heading}${BODY}`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A renamer for a note titled `title`, its server, and a workspace driving it. */
function setup(title: string, options: { canRename?: () => boolean; backlinks?: number } = {}) {
  const server = { title, refuse: null as RenameError | null };
  const renameNote = vi.fn(async (...[, next]: [id: string, title: string, session?: string, expected?: string]) => {
    if (server.refuse) throw server.refuse;
    const previousTitle = server.title;
    server.title = next;
    return { title: next, previousTitle } satisfies RenamedNote;
  });
  const renamer = createHeadingRenamer({ docId: "n1", title, markdown: note(title), renameNote });
  const editor = { text: note(title) };
  const refresh = vi.fn();
  const ctx: HeadingCheck = {
    text: () => editor.text,
    canRename: options.canRename ?? (() => true),
    rename: async (request) => {
      const result = await request("session-1");
      renamer.noteRenamed(result, editor.text);
      return result;
    },
    backlinks: () => options.backlinks ?? 0,
    refresh,
  };
  /** What the workspace shows as the title, for a page title of `page`. */
  const shown = (page: string) => renamer.getSnapshot().overlay ?? page;
  return { renamer, renameNote, server, editor, ctx, refresh, shown };
}

describe("createHeadingRenamer", () => {
  it("renames once per settled edit, naming the title it renames from", async () => {
    const t = setup("Old");
    t.editor.text = note("New");
    t.renamer.check(t.ctx);
    await settle();
    expect(t.renameNote).toHaveBeenCalledExactlyOnceWith("n1", "New", "session-1", "Old");
    expect(t.renamer.title).toBe("New");
    expect(t.refresh).toHaveBeenCalledOnce();
    // The settle after the caret left asks for nothing more.
    t.renamer.check(t.ctx);
    await settle();
    expect(t.renameNote).toHaveBeenCalledOnce();
  });

  it("queues a check made while a rename is in flight, and runs it on the text then", async () => {
    const t = setup("Old");
    let land!: () => void;
    t.renameNote.mockImplementationOnce(
      (_id, next) => new Promise((resolve) => (land = () => resolve({ title: next, previousTitle: "Old" }))),
    );
    t.editor.text = note("New");
    t.renamer.check(t.ctx); // the caret left the heading
    t.renamer.check(t.ctx); // the edit settled, while the first is in flight
    land();
    await settle();
    expect(t.renameNote).toHaveBeenCalledOnce();

    // A further heading change made meanwhile is renamed from the new title.
    t.renameNote.mockClear();
    t.renameNote.mockImplementationOnce(
      (_id, next) => new Promise((resolve) => (land = () => resolve({ title: next, previousTitle: "New" }))),
    );
    t.editor.text = note("Newer");
    t.renamer.check(t.ctx);
    t.editor.text = note("Newest");
    t.renamer.check(t.ctx);
    land();
    await settle();
    await settle();
    expect(t.renameNote.mock.calls.map(([, title, , expected]) => [title, expected])).toEqual([
      ["Newer", "New"],
      ["Newest", "Newer"],
    ]);
  });

  it("fires nothing from a copy that cannot be edited, and keeps its baseline", async () => {
    let editable = false;
    const t = setup("Old", { canRename: () => editable });
    t.editor.text = note("New");
    t.renamer.check(t.ctx);
    await settle();
    expect(t.renameNote).not.toHaveBeenCalled();
    // Once it can be edited, the same edit is compared with the text from before.
    editable = true;
    t.renamer.check(t.ctx);
    await settle();
    expect(t.renameNote).toHaveBeenCalledExactlyOnceWith("n1", "New", "session-1", "Old");
  });

  it("compares from text loaded from outside, renaming nothing for it", async () => {
    const t = setup("Old");
    t.renamer.reset(note("Their Heading"));
    t.editor.text = note("Their Heading");
    t.renamer.check(t.ctx);
    await settle();
    expect(t.renameNote).not.toHaveBeenCalled();
  });

  describe("the title it shows", () => {
    it("shows a rename at once, until the page's title catches up", async () => {
      const t = setup("Old");
      t.editor.text = note("New");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.shown("Old")).toBe("New");
      t.renamer.setPageTitle("New");
      expect(t.renamer.getSnapshot().overlay).toBeNull();
      expect(t.shown("New")).toBe("New");
    });

    it("does not outlive a rename back from the explorer", async () => {
      const t = setup("Old");
      t.editor.text = note("New");
      t.renamer.check(t.ctx);
      await settle();
      t.renamer.setPageTitle("New");
      // The explorer's dialog renames it back, through the editor.
      t.renamer.noteRenamed({ title: "Old", previousTitle: "New" }, note("Old"));
      t.renamer.setPageTitle("Old");
      expect(t.shown("Old")).toBe("Old");
      expect(t.renamer.title).toBe("Old");
    });

    it("does not outlive the explorer's rename even before the page catches up", async () => {
      const t = setup("Old");
      t.editor.text = note("New");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.shown("Old")).toBe("New");
      t.renamer.noteRenamed({ title: "Old", previousTitle: "New" }, note("Old"));
      expect(t.shown("Old")).toBe("Old");
    });

    it("does not outlive a page title it did not predict (a rename from another tab)", async () => {
      const t = setup("Old");
      t.editor.text = note("New");
      t.renamer.check(t.ctx);
      await settle();
      t.renamer.setPageTitle("Elsewhere");
      expect(t.shown("Elsewhere")).toBe("Elsewhere");
      expect(t.renamer.title).toBe("Elsewhere");
    });

    it("keeps the newest of two renames made before the first refresh lands", async () => {
      const t = setup("A");
      t.editor.text = note("B");
      t.renamer.check(t.ctx);
      await settle();
      t.editor.text = note("C");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.shown("A")).toBe("C");

      // Refresh #1 lands with B: behind the newest rename, so C still shows
      // and is what the next edit is compared with.
      t.renamer.setPageTitle("B");
      expect(t.shown("B")).toBe("C");
      expect(t.renamer.title).toBe("C");
      t.editor.text = note("D");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote.mock.calls.map(([, title, , expected]) => [title, expected])).toEqual([
        ["B", "A"],
        ["C", "B"],
        ["D", "C"],
      ]);

      // Refreshes #2 and #3: caught up.
      t.renamer.setPageTitle("C");
      expect(t.shown("C")).toBe("D");
      t.renamer.setPageTitle("D");
      expect(t.renamer.getSnapshot().overlay).toBeNull();
    });

    it("predicts nothing after renaming back to the page's title, so a later B is from outside", async () => {
      const t = setup("A");
      t.editor.text = note("B");
      t.renamer.check(t.ctx);
      await settle();
      t.editor.text = note("A");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renamer.getSnapshot().overlay).toBeNull();

      t.renamer.setPageTitle("B");
      expect(t.shown("B")).toBe("B");
      expect(t.renamer.title).toBe("B");
      t.renamer.reset(note("B"));
      t.editor.text = note("C");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote.mock.calls.map(([, title, , expected]) => [title, expected])).toEqual([
        ["B", "A"],
        ["A", "B"],
        ["C", "B"],
      ]);
    });
  });

  describe("refusals", () => {
    it("warns about a title clash once, keeps the title, and clears when resolved", async () => {
      const t = setup("Plan");
      t.server.refuse = new RenameError("Another note is already called “Roadmap”", 409, "TITLE_TAKEN");
      t.editor.text = note("Roadmap");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renamer.getSnapshot().notice).toEqual({ kind: "clash", heading: "Roadmap", title: "Plan" });
      expect(t.renamer.title).toBe("Plan");

      // Later edits with the same heading do not ask again.
      t.editor.text = `${note("Roadmap")} More.`;
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote).toHaveBeenCalledOnce();

      // Back to the title: cleared, nothing asked.
      t.editor.text = note("Plan");
      t.renamer.check(t.ctx);
      expect(t.renamer.getSnapshot().notice).toBeNull();
      expect(t.renameNote).toHaveBeenCalledOnce();

      // A free title renames, and clears it too.
      t.server.refuse = new RenameError("Another note is already called “Roadmap”", 409, "TITLE_TAKEN");
      t.editor.text = note("Roadmap");
      t.renamer.check(t.ctx);
      await settle();
      t.server.refuse = null;
      t.editor.text = note("Free");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renamer.getSnapshot().notice).toBeNull();
      expect(t.renamer.title).toBe("Free");
    });

    it("leaves a rename made elsewhere alone: no rename, no clash, a refresh, and the heading compared from now on", async () => {
      const t = setup("Old");
      t.server.refuse = new RenameError("This note was renamed", 409, "TITLE_CHANGED", "Their Title");
      t.editor.text = note("Mine");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote).toHaveBeenCalledExactlyOnceWith("n1", "Mine", "session-1", "Old");
      expect(t.renamer.getSnapshot()).toEqual({ notice: null, overlay: null });
      expect(t.renamer.title).toBe("Their Title");
      expect(t.refresh).toHaveBeenCalledOnce();

      // "Mine" was never their title: editing it further renames nothing.
      t.server.refuse = null;
      t.editor.text = note("Mine Again");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote).toHaveBeenCalledOnce();
    });

    it("says nothing more about a lock refusal, and shows any other", async () => {
      const onError = vi.fn();
      const renameNote = vi.fn<(...args: unknown[]) => Promise<RenamedNote>>();
      const renamer = createHeadingRenamer({ docId: "n1", title: "Old", markdown: note("Old"), renameNote, onError });
      let text = note("New");
      const ctx: HeadingCheck = {
        text: () => text,
        canRename: () => true,
        rename: (request) => request("s"),
        backlinks: () => 0,
        refresh: () => {},
      };
      renameNote.mockRejectedValueOnce(new RenameError("Someone else is editing", 423, "LOCKED"));
      renamer.check(ctx);
      await settle();
      renameNote.mockRejectedValueOnce(new RenameError("Saved meanwhile. Try again.", 409, "STALE_VERSION"));
      text = note("Newer");
      renamer.check(ctx);
      await settle();
      expect(onError.mock.calls).toEqual([["Saved meanwhile. Try again."]]);
    });
  });

  it("counts the notes still linking to the old title after a rename", async () => {
    const t = setup("Plan", { backlinks: 3 });
    t.editor.text = note("Roadmap");
    t.renamer.check(t.ctx);
    await settle();
    expect(t.renamer.getSnapshot().notice).toEqual({
      kind: "renamed",
      title: "Roadmap",
      previousTitle: "Plan",
      backlinks: 3,
    });
    t.renamer.dismiss();
    expect(t.renamer.getSnapshot().notice).toBeNull();
  });
});
