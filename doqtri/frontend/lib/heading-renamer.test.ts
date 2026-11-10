import { describe, expect, it, vi } from "vitest";
import { createHeadingRenamer, type HeadingCheck } from "@/lib/heading-renamer";
import { NoResponseError } from "@/lib/no-response";
import { RenameError, SaveBeforeRenameError, type RenamedNote } from "@/lib/rename-note";

const BODY = "\n\n## Scope\n\nBody.";
const note = (heading: string) => `# ${heading}${BODY}`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A renamer for a note titled `title`, its server, and a workspace driving it. */
function setup(
  title: string,
  options: { canRename?: () => boolean; backlinks?: number; onError?: (message: string) => void } = {},
) {
  const server = { title, refuse: null as RenameError | null };
  const renameNote = vi.fn(async (...[, next]: [id: string, title: string, session?: string, expected?: string]) => {
    if (server.refuse) throw server.refuse;
    const previousTitle = server.title;
    server.title = next;
    return { title: next, previousTitle } satisfies RenamedNote;
  });
  const renamer = createHeadingRenamer({
    docId: "n1",
    title,
    markdown: note(title),
    renameNote,
    onError: options.onError,
  });
  const editor = { text: note(title) };
  const refresh = vi.fn();
  // The label the draft store shows, as the workspace would keep it.
  const drafts = { shown: null as string | null, settled: false };
  const draft = vi.fn((title: string | null) => {
    drafts.shown = title;
    drafts.settled = false;
  });
  const landed = vi.fn();
  const settleDraft = vi.fn(() => {
    drafts.settled = true;
  });
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
    draft,
    landed,
    settleDraft,
  };
  /** What the workspace shows as the title, for a page title of `page`. */
  const shown = (page: string) => renamer.getSnapshot().overlay ?? page;
  return { renamer, renameNote, server, editor, ctx, refresh, shown, drafts, draft, landed };
}

describe("createHeadingRenamer", () => {
  it("renames once per settled edit, naming the title it renames from", async () => {
    const t = setup("Old");
    t.editor.text = note("New");
    t.renamer.check(t.ctx);
    await settle();
    expect(t.renameNote).toHaveBeenCalledExactlyOnceWith("n1", "New", "session-1", "Old");
    expect(t.renamer.title).toBe("New");
    // Shown as an accepted rename through the overlay, which asks for the refresh (DOQ-44).
    expect(t.landed).toHaveBeenCalledExactlyOnceWith("New", "Old");
    expect(t.refresh).not.toHaveBeenCalled();
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
        draft: () => {},
        landed: () => {},
        settleDraft: () => {},
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

  describe("drafts (DOQ-44)", () => {
    it("shows the heading as it is typed, before any rename, and hands the landed rename to the overlay", async () => {
      const t = setup("Old");
      t.editor.text = note("Ne");
      t.renamer.typed(t.ctx);
      expect(t.drafts.shown).toBe("Ne");
      t.editor.text = note("New");
      t.renamer.typed();
      expect(t.drafts.shown).toBe("New");
      expect(t.renameNote).not.toHaveBeenCalled();

      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote).toHaveBeenCalledOnce();
      expect(t.landed).toHaveBeenCalledExactlyOnceWith("New", "Old");
      // The draft stays until the overlay shows what landed; the store drops it then.
      expect(t.drafts.shown).toBe("New");
      // An edit after, in the body, says the heading is the title now: no draft.
      t.editor.text = `${note("New")} More.`;
      t.renamer.typed();
      expect(t.drafts.shown).toBeNull();
    });

    it("shows no draft for an emptied, invalid or unchanged heading, nor from a copy that cannot rename", () => {
      let editable = true;
      const t = setup("Old", { canRename: () => editable });
      t.editor.text = note("New");
      t.renamer.typed(t.ctx);
      expect(t.drafts.shown).toBe("New");
      t.editor.text = "# \n\n## Scope\n\nBody.";
      t.renamer.typed();
      expect(t.drafts.shown).toBeNull();
      t.editor.text = note("x".repeat(1000));
      t.renamer.typed();
      expect(t.drafts.shown).toBeNull();
      t.editor.text = note("old");
      t.renamer.typed();
      expect(t.drafts.shown).toBeNull();
      editable = false;
      t.editor.text = note("New");
      t.renamer.typed();
      expect(t.drafts.shown).toBeNull();
    });

    it("drops the draft when the rename is refused, and shows none for the clashing heading again", async () => {
      const t = setup("Old");
      t.server.refuse = new RenameError("Taken", 409, "TITLE_TAKEN");
      t.editor.text = note("Taken");
      t.renamer.typed(t.ctx);
      expect(t.drafts.shown).toBe("Taken");
      t.renamer.check();
      await settle();
      expect(t.drafts.shown).toBeNull();
      expect(t.landed).not.toHaveBeenCalled();
      expect(t.renamer.getSnapshot().notice?.kind).toBe("clash");
      // An edit in the body while the clash stands brings no draft back.
      t.editor.text = `${note("Taken")} More.`;
      t.renamer.typed();
      expect(t.drafts.shown).toBeNull();
    });

    it("keeps the draft of a heading typed on while a refused rename was out", async () => {
      const t = setup("Old");
      let refuse!: () => void;
      t.renameNote.mockImplementationOnce(
        () => new Promise((_, reject) => (refuse = () => reject(new RenameError("Taken", 409, "TITLE_TAKEN")))),
      );
      t.editor.text = note("Taken");
      t.renamer.typed(t.ctx);
      t.renamer.check();
      t.editor.text = note("Taken Two");
      t.renamer.typed();
      refuse();
      await settle();
      expect(t.renamer.getSnapshot().notice?.kind).toBe("clash");
      // No frame back to "Old" before the next rename: the newer heading shows.
      expect(t.draft.mock.calls.slice(-1)).toEqual([["Taken Two"]]);
      expect(t.draft).not.toHaveBeenCalledWith(null);
    });

    it.each([
      ["TITLE_CHANGED", new RenameError("Renamed elsewhere", 409, "TITLE_CHANGED", "Theirs")],
      ["a lock refusal", new RenameError("Someone else is editing", 423, "LOCKED")],
      ["an invalid title", new RenameError("Invalid title", 400, "INVALID_TITLE")],
    ])("drops the draft on %s", async (_, refusal) => {
      const t = setup("Old");
      t.server.refuse = refusal;
      t.editor.text = note("New");
      t.renamer.typed(t.ctx);
      t.renamer.check();
      await settle();
      expect(t.drafts.shown).toBeNull();
      expect(t.landed).not.toHaveBeenCalled();
    });

    it("drops the draft when the note closes before the edit settles", () => {
      const t = setup("Old");
      t.renamer.check(t.ctx);
      t.editor.text = note("New");
      t.renamer.typed();
      t.renamer.leave();
      expect(t.drafts.shown).toBeNull();
      t.renamer.typed();
      expect(t.drafts.shown).toBeNull();
    });

    it("still runs the check queued behind a rename in flight when the note closes, then lets the draft go", async () => {
      const t = setup("Old");
      let land!: () => void;
      t.renameNote.mockImplementationOnce(
        (_id, next) => new Promise((resolve) => (land = () => resolve({ title: next, previousTitle: "Old" }))),
      );
      t.editor.text = note("New");
      t.renamer.typed(t.ctx);
      t.renamer.check();
      // Typed on and settled (saved) while the rename was out, then closed.
      t.editor.text = note("Newer");
      t.renamer.typed();
      t.renamer.check();
      t.renamer.leave();
      expect(t.drafts.shown).toBe("Newer");
      const draftedBefore = t.draft.mock.calls.length;
      land();
      await settle();
      await settle();
      expect(t.renameNote).toHaveBeenCalledTimes(2);
      expect(t.renameNote).toHaveBeenLastCalledWith("n1", "Newer", "session-1", "New");
      expect(t.renamer.title).toBe("Newer");
      expect(t.landed.mock.calls).toEqual([
        ["New", "Old"],
        ["Newer", "New"],
      ]);
      // Nothing more is on its way: the draft goes once what landed shows.
      expect(t.drafts.settled).toBe(true);
      // Nothing drafted after the note closed: no flash back to "New" or "Old".
      expect(t.draft).toHaveBeenCalledTimes(draftedBefore);
    });
  });

  describe("a rename from the explorer that overtakes an edit of the title line (DOQ-46)", () => {
    it("drops the edit's rename and its draft: the explorer's title is the one shown", async () => {
      // The prod drift: one character deleted from the title line, then renamed from
      // the explorer before that edit settled. The explorer's rename is the later word.
      const t = setup("No title");
      t.editor.text = note("No titl");
      t.renamer.typed(t.ctx);
      expect(t.drafts.shown).toBe("No titl");

      // The explorer's rename shows at once (DOQ-32's overlay)...
      t.renamer.setPageTitle("No titlesdffga");
      // ...and the draft worked out against the old title goes with it.
      expect(t.drafts.shown).toBeNull();

      // The edit settles: compared with the explorer's title, it renames nothing.
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote).not.toHaveBeenCalled();
      expect(t.drafts.shown).toBeNull();
      expect(t.renamer.title).toBe("No titlesdffga");
    });

    it("drafts nothing from the explorer's answer, read before the editor shows the renamed text", () => {
      // The workspace hands over the rewritten text before the editor shows it:
      // compared then, the old heading would read as a rename back to the old title.
      const t = setup("Untitled");
      t.renamer.typed(t.ctx);
      t.renamer.setPageTitle("Renamed");
      const drafted = t.draft.mock.calls.length;
      t.renamer.noteRenamed({ title: "Renamed", previousTitle: "Untitled" }, note("Renamed"));
      expect(t.draft).toHaveBeenCalledTimes(drafted);
      expect(t.drafts.shown).toBeNull();
      t.editor.text = note("Renamed");
      t.renamer.typed();
      expect(t.drafts.shown).toBeNull();
    });

    it("once line 1 is rewritten to the explorer's title, editing it renames from that title", async () => {
      const t = setup("No title");
      t.editor.text = note("No titl");
      t.renamer.setPageTitle("No titlesdffga");
      t.renamer.check(t.ctx);
      await settle();
      // The workspace rewrites line 1 (rename-adopt.ts titleLineAfterRename) and resets the comparison.
      t.editor.text = note("No titlesdffga");
      t.renamer.reset(t.editor.text);
      t.editor.text = note("No titlesdffg");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote).toHaveBeenCalledExactlyOnceWith("n1", "No titlesdffg", "session-1", "No titlesdffga");
      expect(t.renamer.title).toBe("No titlesdffg");
    });

    it("an own rename answered after the explorer's was confirmed does not show over it", async () => {
      // The review's order: the title line's rename to "Pla" in flight, then the
      // explorer's rename to "Roadmap" confirmed, then the own answer.
      const t = setup("Plan");
      let answer!: () => void;
      t.renameNote.mockImplementationOnce(
        (_id, next) => new Promise((resolve) => (answer = () => resolve({ title: next, previousTitle: "Plan" }))),
      );
      t.editor.text = note("Pla");
      t.renamer.check(t.ctx);
      expect(t.renameNote).toHaveBeenCalledOnce();
      t.renamer.setPageTitle("Roadmap");
      expect(t.shown("Roadmap")).toBe("Roadmap");
      answer();
      await settle();
      // No Roadmap → Pla → Roadmap: nothing pending, nothing landed over it.
      expect(t.renamer.title).toBe("Roadmap");
      expect(t.renamer.getSnapshot().overlay).toBeNull();
      expect(t.shown("Roadmap")).toBe("Roadmap");
      expect(t.landed).not.toHaveBeenCalled();
      // Its text is compared from now on: the explorer's rewrite of it renames nothing.
      t.renamer.noteRenamed({ title: "Roadmap", previousTitle: "Pla" }, note("Roadmap"));
      t.editor.text = note("Roadmap");
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote).toHaveBeenCalledOnce();
    });

    it("tells its own renames apart from the explorer's", async () => {
      const t = setup("Old");
      const answers: RenamedNote[] = [];
      const ctx: HeadingCheck = {
        ...t.ctx,
        rename: async (request) => {
          const result = await request("session-1");
          answers.push(result);
          return result;
        },
      };
      t.editor.text = note("New");
      t.renamer.check(ctx);
      await settle();
      expect(answers).toHaveLength(1);
      expect(t.renamer.isOwn(answers[0])).toBe(true);
      expect(t.renamer.isOwn({ title: "Other", previousTitle: "New" })).toBe(false);
    });
  });

  describe("failures that are not refusals say so (DOQ-46)", () => {
    it("not a save that failed before the rename, which says so itself, nor a lost lock", async () => {
      const onError = vi.fn();
      const t = setup("Old", { onError });
      const failing = (message: string): HeadingCheck => ({
        ...t.ctx,
        rename: async () => {
          throw new SaveBeforeRenameError(message);
        },
      });
      t.editor.text = note("New");
      t.renamer.typed(t.ctx);
      t.renamer.check(failing("Your edits could not be saved, so the note was not renamed. Could not save (500)"));
      await settle();
      t.renamer.check(failing("Your edits could not be saved, so the note was not renamed. Ana is editing this note"));
      await settle();
      expect(onError).not.toHaveBeenCalled();
      expect(t.drafts.shown).toBeNull();
      expect(t.renamer.title).toBe("Old");
      // The baseline stayed: the next settled edit tries again.
      t.renamer.check(t.ctx);
      await settle();
      expect(t.renameNote).toHaveBeenCalledExactlyOnceWith("n1", "New", "session-1", "Old");
    });

    it("a failure nothing else explains", async () => {
      const onError = vi.fn();
      const t = setup("Old", { onError });
      t.renameNote.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      t.editor.text = note("New");
      t.renamer.check(t.ctx);
      await settle();
      expect(onError).toHaveBeenCalledExactlyOnceWith("Failed to fetch");
    });

    it("no answer from the server", async () => {
      const onError = vi.fn();
      const t = setup("Old", { onError });
      t.renameNote.mockRejectedValueOnce(new NoResponseError());
      t.editor.text = note("New");
      t.renamer.check(t.ctx);
      await settle();
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        "Could not reach doqtri, so the note may not have been renamed to “New”.",
      );
    });

    it("but not a lock refusal, which the edit-lock banner already explains", async () => {
      const onError = vi.fn();
      const t = setup("Old", { onError });
      t.server.refuse = new RenameError("Someone is editing this note", 423, "LOCKED");
      t.editor.text = note("New");
      t.renamer.check(t.ctx);
      await settle();
      expect(onError).not.toHaveBeenCalled();
    });
  });
});
