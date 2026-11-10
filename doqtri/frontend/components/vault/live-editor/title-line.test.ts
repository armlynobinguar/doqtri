import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, StateEffect, Transaction, type TransactionSpec } from "@codemirror/state";
import {
  insertNewline,
  copyLineDown,
  copyLineUp,
  history,
  moveLineDown,
  moveLineUp,
  redo,
  transposeChars,
  undo,
} from "@codemirror/commands";
import { external, readOnlyGuard } from "@/components/vault/live-editor/read-only";
import {
  enterFromTitle,
  guarded,
  lineMoveKeys,
  releaseTitleLine,
  setNoteTitle,
  titleLine,
  titleLineChange,
  titleLineDecorations,
} from "@/components/vault/live-editor/title-line";
import { setParagraphStyle, toggleCodeBlock, toggleInline, toggleList } from "@/lib/live-preview/commands";

const BODY = "\n\n## Scope\n\nText.";

function make(doc: string, opts: { caret?: number; readOnly?: boolean } = {}) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(opts.caret ?? 0),
    extensions: [history(), EditorState.readOnly.of(opts.readOnly ?? false), readOnlyGuard, titleLine("Plan")],
  });
}

/** Applies one edit as the editor would, and returns the text and caret after it. */
function edit(state: EditorState, spec: TransactionSpec) {
  const next = state.update(spec).state;
  return { state: next, text: next.doc.toString(), caret: next.selection.main.head };
}

/** Runs a command against a state, the way a key binding would. */
function run(state: EditorState, command: (target: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean) {
  let current = state;
  const handled = command({ state, dispatch: (tr) => (current = tr.state) });
  return { handled, state: current, text: current.doc.toString(), caret: current.selection.main.head };
}

/** As run(), for the commands that take a dispatch of specs (enterFromTitle). */
function press(state: EditorState) {
  let current = state;
  const handled = enterFromTitle({ state, dispatch: (spec) => (current = current.update(spec).state) });
  return { handled, text: current.doc.toString(), caret: current.selection.main.head };
}

describe("the title line guard (D-120)", () => {
  describe("keeps the `# ` prefix", () => {
    it("Backspace at the start of the title, or inside the `# `, deletes nothing", () => {
      const state = make(`# Plan${BODY}`, { caret: 2 });
      for (const [from, to] of [
        [1, 2],
        [0, 1],
        [0, 2],
      ]) {
        const after = edit(state, { changes: { from, to }, userEvent: "delete.backward" });
        expect(after.text, `${from}-${to}`).toBe(`# Plan${BODY}`);
      }
    });

    it("selecting the `# ` and part of the title, then deleting, keeps the `# `", () => {
      expect(edit(make(`# Plan${BODY}`), { changes: { from: 0, to: 4 } }).text).toBe(`# an${BODY}`);
    });

    it("turning it into `##`, by typing or from the toolbar, is undone", () => {
      const state = make(`# Plan${BODY}`, { caret: 0 });
      expect(edit(state, { changes: { from: 0, insert: "#" }, userEvent: "input.type" }).text).toBe(`# Plan${BODY}`);
      expect(edit(state, { changes: { from: 1, insert: "#" }, userEvent: "input.type" }).text).toBe(`# Plan${BODY}`);
      expect(edit(state, { changes: { from: 0, to: 2, insert: "## " }, userEvent: "input.format" }).text).toBe(
        `# Plan${BODY}`,
      );
      // Toolbar block markup (a list, a quote) does not go before the title either.
      expect(edit(state, { changes: { from: 0, insert: "- " }, userEvent: "input.format" }).text).toBe(
        `# Plan${BODY}`,
      );
      expect(edit(state, { changes: { from: 0, insert: "> " }, userEvent: "input.format" }).text).toBe(
        `# Plan${BODY}`,
      );
    });

    it("turning it into prose, by deleting the `# `, is undone", () => {
      expect(edit(make(`# Plan${BODY}`), { changes: { from: 0, to: 2 }, userEvent: "delete" }).text).toBe(`# Plan${BODY}`);
    });

    it("text typed before the `#` goes to the start of the title", () => {
      const after = edit(make(`# Plan${BODY}`), { changes: { from: 0, insert: "My " }, userEvent: "input.type" });
      expect(after.text).toBe(`# My Plan${BODY}`);
      expect(after.caret).toBe(5);
    });

    it("formatting that reaches into the `# ` does nothing; inside the title's text it wraps", () => {
      const state = make(`# Plan${BODY}`);
      const into = edit(state, {
        changes: [
          { from: 0, insert: "**" },
          { from: 6, insert: "**" },
        ],
        userEvent: "input.format",
      });
      expect(into.text).toBe(`# Plan${BODY}`);
      const inside = edit(state, {
        changes: [
          { from: 2, insert: "**" },
          { from: 6, insert: "**" },
        ],
        userEvent: "input.format",
      });
      expect(inside.text).toBe(`# **Plan**${BODY}`);
    });

    it("an empty title keeps its `# ` too", () => {
      expect(edit(make(`# ${BODY}`, { caret: 2 }), { changes: { from: 1, to: 2 } }).text).toBe(`# ${BODY}`);
    });
  });

  describe("never merges the body into the title", () => {
    it("Backspace at the start of line 2 does nothing, and the caret stays", () => {
      const after = edit(make(`# Plan\nBody`, { caret: 7 }), { changes: { from: 6, to: 7 }, userEvent: "delete.backward" });
      expect(after.text).toBe("# Plan\nBody");
      expect(after.caret).toBe(7);
    });

    it("Delete at the end of line 1 does nothing", () => {
      const after = edit(make(`# Plan${BODY}`, { caret: 6 }), { changes: { from: 6, to: 7 }, userEvent: "delete.forward" });
      expect(after.text).toBe(`# Plan${BODY}`);
      expect(after.caret).toBe(6);
    });

    it("a selection from the title into the body deletes both parts and keeps the line break", () => {
      // "# Pl|an\nBo|dy" -> typing "x"
      const typed = edit(make("# Plan\nBody"), { changes: { from: 4, to: 9, insert: "x" }, userEvent: "input.type" });
      expect(typed.text).toBe("# Plx\ndy");
      expect(typed.caret).toBe(5);
      const deleted = edit(make("# Plan\nBody"), { changes: { from: 4, to: 9 }, userEvent: "delete" });
      expect(deleted.text).toBe("# Pl\ndy");
      expect(deleted.caret).toBe(4);
    });

    it("the title line selected with its line break and typed over keeps both", () => {
      const after = edit(make("# Plan\nBody"), { changes: { from: 0, to: 7, insert: "New" }, userEvent: "input.type" });
      expect(after.text).toBe("# New\nBody");
    });

    it("deleting a trailing empty line under the title is fine: nothing joins", () => {
      expect(edit(make("# Plan\n", { caret: 7 }), { changes: { from: 6, to: 7 }, userEvent: "delete.backward" }).text).toBe(
        "# Plan",
      );
    });
  });

  describe("never splits the title", () => {
    it("Enter on the title moves the caret to the start of the body", () => {
      for (const caret of [0, 2, 4, 6]) {
        const after = press(make(`# Plan${BODY}`, { caret }));
        expect(after.handled).toBe(true);
        expect(after.text).toBe(`# Plan${BODY}`);
        expect(after.caret).toBe(7);
      }
    });

    it("Enter on a note with no body adds the line it moves to", () => {
      const after = press(make("# Plan", { caret: 3 }));
      expect(after.text).toBe("# Plan\n");
      expect(after.caret).toBe(7);
    });

    it("Enter with a selection in the title moves without deleting it", () => {
      const state = make(`# Plan${BODY}`).update({ selection: EditorSelection.range(2, 6) }).state;
      const after = press(state);
      expect(after.text).toBe(`# Plan${BODY}`);
      expect(after.caret).toBe(7);
    });

    it("Enter in the body is not the title's", () => {
      expect(press(make(`# Plan${BODY}`, { caret: 8 })).handled).toBe(false);
    });

    it("a line break typed into the title some other way (a phone keyboard) moves to the body too", () => {
      const after = edit(make(`# Plan${BODY}`, { caret: 4 }), { changes: { from: 4, insert: "\n" }, userEvent: "input" });
      expect(after.text).toBe(`# Plan${BODY}`);
      expect(after.caret).toBe(7);
      const end = edit(make("# Plan", { caret: 6 }), { changes: { from: 6, insert: "\n" }, userEvent: "input" });
      expect(end.text).toBe("# Plan\n");
      expect(end.caret).toBe(7);
    });

    it("pasting several lines into the title keeps the first there and the rest at the start of the body", () => {
      // The whole title selected and pasted over.
      const over = edit(make(`# Plan${BODY}`), { changes: { from: 2, to: 6, insert: "A\nB\nC" }, userEvent: "input.paste" });
      expect(over.text).toBe(`# A\nB\nC\n${BODY.slice(1)}`);
      expect(over.caret).toBe("# A\nB\nC".length);
      // At the caret in the middle of the title: its tail stays in the title.
      const middle = edit(make("# Plan\nBody"), { changes: { from: 4, insert: "X\nY" }, userEvent: "input.paste" });
      expect(middle.text).toBe("# PlXan\nY\nBody");
      // A note with no body yet.
      const alone = edit(make("# Plan"), { changes: { from: 2, to: 6, insert: "A\nB\nC" }, userEvent: "input.paste" });
      expect(alone.text).toBe("# A\nB\nC");
      expect(alone.caret).toBe(alone.text.length);
    });

    it("reads a pasted CRLF text as lines, like any other", () => {
      const state = make(`# Plan${BODY}`);
      const after = edit(state, { changes: { from: 2, to: 6, insert: state.toText("A\r\nB\r\nC").toString() } });
      expect(after.text).toBe(`# A\nB\nC\n${BODY.slice(1)}`);
    });
  });

  describe("replacing the whole note", () => {
    it("select all and delete leaves `# ` with an empty title", () => {
      const state = make(`# Plan${BODY}`);
      expect(edit(state, { changes: { from: 0, to: state.doc.length }, userEvent: "delete" }).text).toBe("# ");
      const single = make("# Plan");
      expect(edit(single, { changes: { from: 0, to: single.doc.length }, userEvent: "delete" }).text).toBe("# ");
    });

    it("select all and typing puts the text under an empty title", () => {
      const state = make(`# Plan${BODY}`);
      const after = edit(state, { changes: { from: 0, to: state.doc.length, insert: "H" }, userEvent: "input.type" });
      expect(after.text).toBe("# \nH");
      expect(after.caret).toBe(4);
      const single = make("# Plan");
      expect(edit(single, { changes: { from: 0, to: 6, insert: "H" }, userEvent: "input.type" }).text).toBe("# \nH");
    });

    it("a pasted note keeps its own title line, or goes under an empty one", () => {
      const state = make(`# Plan${BODY}`);
      const all = { from: 0, to: state.doc.length };
      expect(edit(state, { changes: { ...all, insert: "# Pasted\n\nAll new." } }).text).toBe("# Pasted\n\nAll new.");
      expect(edit(state, { changes: { ...all, insert: "#\n\nAll new." } }).text).toBe("# \n\nAll new.");
      expect(edit(state, { changes: { ...all, insert: `## Plan notes${BODY}` } }).text).toBe(`# \n## Plan notes${BODY}`);
      expect(edit(state, { changes: { ...all, insert: `Some prose.${BODY}` } }).text).toBe(`# \nSome prose.${BODY}`);
    });
  });

  it("leaves wikilinks in the title alone, and pastes into them like any other text", () => {
    const state = make(`# [[Target|Plan]]${BODY}`);
    expect(edit(state, { changes: { from: 11, to: 15, insert: "Road" } }).text).toBe(`# [[Target|Road]]${BODY}`);
    expect(edit(make(`# Plan${BODY}`), { changes: { from: 2, to: 6, insert: "[[A]]\nB" } }).text).toBe(
      `# [[A]]\nB\n${BODY.slice(1)}`,
    );
  });

  it("lets edits that keep the title line through untouched", () => {
    const state = make(`# Plan${BODY}`, { caret: 6 });
    const typed = state.update({ changes: { from: 6, insert: "s" }, userEvent: "input.type" });
    expect(typed.state.doc.toString()).toBe(`# Plans${BODY}`);
    const body = state.update({ changes: { from: 8, to: 10, insert: "###" }, userEvent: "input.type" });
    expect(body.state.doc.toString()).toBe(`# Plan\n\n### Scope\n\nText.`);
  });

  it("does not guard text loaded from outside, a read-only copy, or a note with no title line yet", () => {
    const loaded = make(`# Plan${BODY}`).update({
      changes: { from: 0, to: 2 },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
    expect(loaded.state.doc.toString()).toBe(`Plan${BODY}`);
    // Not a title line: nothing to keep (lib/title-line.ts adds one when it can be edited).
    expect(edit(make(`Prose${BODY}`), { changes: { from: 0, insert: "More " } }).text).toBe(`More Prose${BODY}`);
    // The editor's own title line changes pass as they are.
    expect(
      edit(make("Prose"), { changes: { from: 0, insert: "# Plan\n\n" }, annotations: titleLineChange.of(true) }).text,
    ).toBe("# Plan\n\nProse");
  });

  describe("commands that reach line 1, run as the keys run them", () => {
    const DOC = "# Plan\nline2\nline3";

    it("moving or copying lines never touches the title line", () => {
      for (const [command, caret] of [
        [moveLineDown, 3],
        [moveLineUp, 3],
        [copyLineDown, 3],
        [copyLineUp, 3],
        [moveLineUp, 9],
      ] as const) {
        const after = run(make(DOC, { caret }), command);
        expect(after.text, `${command.name} at ${caret}`).toBe(DOC);
      }
      // Below the title they work as ever.
      expect(run(make(DOC, { caret: 9 }), moveLineDown).text).toBe("# Plan\nline3\nline2");
      expect(run(make(DOC, { caret: 9 }), copyLineUp).text).toBe("# Plan\nline2\nline2\nline3");
      expect(run(make(DOC, { caret: 9 }), copyLineDown).text).toBe("# Plan\nline2\nline2\nline3");
    });

    it("takes Alt-↑/↓ and Shift-Alt-↑/↓ when they would reach the title, so nothing else runs", () => {
      expect(lineMoveKeys.moveDown({ state: make(DOC, { caret: 3 }) })).toBe(true);
      expect(lineMoveKeys.copyDown({ state: make(DOC, { caret: 3 }) })).toBe(true);
      expect(lineMoveKeys.copyUp({ state: make(DOC, { caret: 3 }) })).toBe(true);
      expect(lineMoveKeys.moveUp({ state: make(DOC, { caret: 9 }) })).toBe(true);
      // Line 2 copied up, or moved down, stays in the body: the keys are the editor's.
      expect(lineMoveKeys.copyUp({ state: make(DOC, { caret: 9 }) })).toBe(false);
      expect(lineMoveKeys.moveDown({ state: make(DOC, { caret: 9 }) })).toBe(false);
      expect(lineMoveKeys.moveUp({ state: make(DOC, { caret: 15 }) })).toBe(false);
    });

    it("Ctrl-T never swaps characters across the end of the title line", () => {
      expect(run(make(DOC, { caret: 7 }), transposeChars).text).toBe(DOC);
      expect(run(make(DOC, { caret: 6 }), transposeChars).text).toBe(DOC);
      // Inside the title, or the body, it swaps as usual.
      expect(run(make(DOC, { caret: 4 }), transposeChars).text).toBe("# Paln\nline2\nline3");
      expect(run(make(DOC, { caret: 9 }), transposeChars).text).toBe("# Plan\nlnie2\nline3");
    });

    it("block styles from the toolbar do nothing on the title line; inline ones wrap its text", () => {
      for (const command of [toggleCodeBlock, setParagraphStyle("h2"), setParagraphStyle("quote"), setParagraphStyle("normal"), toggleList("bullet")]) {
        const state = make(DOC, { caret: 4 });
        expect(state.update(command(state)).state.doc.toString()).toBe(DOC);
      }
      const word = make(DOC).update({ selection: EditorSelection.range(2, 6) }).state;
      expect(word.update(toggleInline("bold")(word)).state.doc.toString()).toBe("# **Plan**\nline2\nline3");
      // In the body, block styles work as ever.
      const body = make(DOC, { caret: 9 });
      expect(body.update(setParagraphStyle("h2")(body)).state.doc.toString()).toBe("# Plan\n## line2\nline3");
    });

    it("whole lines put above the title (they end in a line break) go to the start of the body", () => {
      const after = edit(make(DOC, { caret: 0 }), { changes: { from: 0, insert: "moved\n" }, userEvent: "input.paste" });
      expect(after.text).toBe("# Plan\nmoved\nline2\nline3");
    });

    it("a title line cut and pasted lower leaves an empty title, and the heading below it is body text", () => {
      const cut = edit(make(DOC), { changes: { from: 0, to: 7 }, userEvent: "delete.cut" }).state;
      expect(cut.doc.toString()).toBe("# \nline2\nline3");
      const pasted = edit(cut, { changes: { from: cut.doc.length, insert: "\n# Plan" }, userEvent: "input.paste" });
      expect(pasted.text).toBe("# \nline2\nline3\n# Plan");
    });
  });

  describe("when it guards (one rule: lib/title-heading.ts isTitleHeading)", () => {
    it("guards line 1 only when it is the title line: it says the title, is exactly `# <title>`, or is an empty `# `", () => {
      const deleteHash = (state: EditorState) => edit(state, { changes: { from: 0, to: 2 }, userEvent: "delete" }).text;
      expect(deleteHash(make(`# Plan${BODY}`))).toBe(`# Plan${BODY}`);
      expect(deleteHash(make(`# [[Target|Plan]]${BODY}`))).toBe(`# [[Target|Plan]]${BODY}`);
      expect(deleteHash(make(`# ${BODY}`))).toBe(`# ${BODY}`);
      // A heading that says something else is the note's own: edited as any text.
      expect(deleteHash(make(`# Introduction${BODY}`))).toBe(`Introduction${BODY}`);
    });

    it("keeps guarding a title being retyped, before the rename it asks for lands", () => {
      const retyped = edit(make(`# Plan${BODY}`), { changes: { from: 2, to: 6, insert: "Roadmap" }, userEvent: "input.type" });
      expect(retyped.text).toBe(`# Roadmap${BODY}`);
      expect(edit(retyped.state, { changes: { from: 0, to: 2 }, userEvent: "delete" }).text).toBe(`# Roadmap${BODY}`);
    });

    it("reads the rule afresh when the title changes, and when text is loaded from outside", () => {
      const other = make(`# Other${BODY}`);
      const titled = other.update({ effects: setNoteTitle.of("Other") }).state;
      expect(edit(titled, { changes: { from: 0, to: 2 }, userEvent: "delete" }).text).toBe(`# Other${BODY}`);
      // Someone else's text, with a heading the title does not say: not guarded.
      const loaded = make(`# Plan${BODY}`).update({
        changes: { from: 2, to: 6, insert: "Theirs" },
        annotations: [external.of(true), Transaction.addToHistory.of(false)],
      }).state;
      expect(edit(loaded, { changes: { from: 0, to: 2 }, userEvent: "delete" }).text).toBe(`Theirs${BODY}`);
    });
  });

  describe("a rename from outside the editor (the sidebar), before the renamed text lands", () => {
    const pending = (state: EditorState) => {
      const shown: string[] = [];
      titleLineDecorations(state).between(0, state.doc.length, (from, to, deco) => {
        if (from < to && deco.spec.widget) shown.push(`${from}-${to}:${(deco.spec.widget as { title: string }).title}`);
      });
      return shown;
    };
    const blockWidgets = (state: EditorState) => {
      let count = 0;
      titleLineDecorations(state).between(0, 0, (_from, _to, deco) => {
        if (deco.spec.block) count++;
      });
      return count;
    };
    const renamed = () => make(`# Plan${BODY}`).update({ effects: setNoteTitle.of("Roadmap") }).state;

    it("keeps line 1 the title line and shows the new title in it, with no second title above", () => {
      const state = renamed();
      expect(pending(state)).toEqual(["2-6:Roadmap"]);
      expect(blockWidgets(state)).toBe(0);
      // Still guarded: the `# ` cannot be deleted.
      expect(edit(state, { changes: { from: 0, to: 2 }, userEvent: "delete" }).text).toBe(`# Plan${BODY}`);
    });

    it("shows the real line again once the renamed text lands", () => {
      const landed = renamed().update({
        changes: { from: 2, to: 6, insert: "Roadmap" },
        annotations: [external.of(true), Transaction.addToHistory.of(false)],
      }).state;
      expect(landed.doc.line(1).text).toBe("# Roadmap");
      expect(pending(landed)).toEqual([]);
      expect(blockWidgets(landed)).toBe(0);
    });

    it("shows the old title again when the rename is undone (it failed)", () => {
      const reverted = renamed().update({ effects: setNoteTitle.of("Plan") }).state;
      expect(pending(reverted)).toEqual([]);
      expect(blockWidgets(reverted)).toBe(0);
    });

    it("shows line 1's real text again when it is edited meanwhile, and keeps an edit below it pending", () => {
      const below = edit(renamed(), { changes: { from: 9, insert: "x" }, userEvent: "input.type" }).state;
      expect(pending(below)).toEqual(["2-6:Roadmap"]);
      const onLine = edit(renamed(), { changes: { from: 6, insert: "s" }, userEvent: "input.type" }).state;
      expect(onLine.doc.line(1).text).toBe("# Plans");
      expect(pending(onLine)).toEqual([]);
    });

    it("a note whose line 1 is not its title line still shows the new title above it", () => {
      const state = make(`# Introduction${BODY}`).update({ effects: setNoteTitle.of("Roadmap") }).state;
      expect(pending(state)).toEqual([]);
      expect(blockWidgets(state)).toBe(1);
    });

    describe("settling with no renamed text coming (DOQ-46)", () => {
      /** Whether line 1 is styled as the title. */
      const styled = (state: EditorState) => {
        let found = false;
        titleLineDecorations(state).between(0, 0, (_from, _to, deco) => {
          if ((deco.spec as { class?: string }).class === "cm-title-line") found = true;
        });
        return found;
      };
      /** `# Pla`: the title line with one character deleted, its rename not fired yet. */
      const retyped = () => edit(make(`# Plan${BODY}`), { changes: { from: 5, to: 6 }, userEvent: "delete.backward" }).state;

      it("without a release, the new title stays over the old line however long nothing lands", () => {
        // What the drifted prod note showed: line 1 kept its old text under the new title.
        let state = renamed();
        for (let at = 9; at < 12; at++) state = state.update({ selection: EditorSelection.cursor(at) }).state;
        expect(pending(state)).toEqual(["2-6:Roadmap"]);
        expect(guarded(state)).toBe(true);
      });

      it("a release lets a line 1 that does not say the title go: not styled, not guarded, the title above it", () => {
        const released = renamed().update({ effects: releaseTitleLine.of(null) }).state;
        expect(guarded(released)).toBe(false);
        expect(pending(released)).toEqual([]);
        expect(blockWidgets(released)).toBe(1);
        expect(styled(released)).toBe(false);
        // Its `# ` is ordinary text now.
        expect(edit(released, { changes: { from: 0, to: 2 }, userEvent: "delete" }).text).toBe(`Plan${BODY}`);
      });

      it("a release keeps a line 1 that says the title, which shows as it is", () => {
        const landed = renamed().update({
          changes: { from: 2, to: 6, insert: "Roadmap" },
          annotations: [external.of(true), Transaction.addToHistory.of(false)],
        }).state;
        const released = landed.update({ effects: releaseTitleLine.of(null) }).state;
        expect(guarded(released)).toBe(true);
        expect(styled(released)).toBe(true);
        expect(pending(released)).toEqual([]);
        expect(blockWidgets(released)).toBe(0);
      });

      it("a release lets go of a title being retyped that the rename overtook", () => {
        const state = retyped();
        expect(guarded(state)).toBe(true);
        const renamedAway = state.update({ effects: setNoteTitle.of("Roadmap") }).state;
        expect(pending(renamedAway)).toEqual(["2-5:Roadmap"]);
        const released = renamedAway.update({ effects: releaseTitleLine.of(null) }).state;
        expect(guarded(released)).toBe(false);
        expect(pending(released)).toEqual([]);
        expect(blockWidgets(released)).toBe(1);
      });

      it("line 1 rewritten from outside to the new title is guarded and shows as it is", () => {
        // The workspace's rewrite of a retyped line 1 (rename-adopt.ts titleLineAfterRename).
        const renamedAway = retyped().update({ effects: setNoteTitle.of("Roadmap") }).state;
        const rewritten = renamedAway.update({
          changes: { from: 2, to: 5, insert: "Roadmap" },
          annotations: [external.of(true), Transaction.addToHistory.of(false)],
        }).state;
        expect(rewritten.doc.toString()).toBe(`# Roadmap${BODY}`);
        expect(guarded(rewritten)).toBe(true);
        expect(styled(rewritten)).toBe(true);
        expect(pending(rewritten)).toEqual([]);
        expect(blockWidgets(rewritten)).toBe(0);
      });
    });
  });

  it("leaves Enter with several carets to the default, which the guard then keeps on track", () => {
    const state = EditorState.create({
      doc: `# Plan${BODY}`,
      selection: EditorSelection.create([EditorSelection.cursor(4), EditorSelection.cursor(11)]),
      extensions: [EditorState.allowMultipleSelections.of(true), titleLine("Plan")],
    });
    expect(press(state).handled).toBe(false);
    const after = run(state, insertNewline);
    // The title is not split; the body's line is.
    expect(after.text).toBe("# Plan\n\n## \nScope\n\nText.");
    expect(after.state.selection.ranges).toHaveLength(2);
  });

  it("keeps every caret of a multiple selection when it corrects an edit", () => {
    const state = EditorState.create({
      doc: `# Plan${BODY}`,
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(9)]),
      extensions: [EditorState.allowMultipleSelections.of(true), titleLine("Plan")],
    });
    const after = state.update(state.replaceSelection("x")).state;
    expect(after.doc.toString()).toBe(`# xPlan\n\n#x# Scope\n\nText.`);
    expect(after.selection.ranges.map((range) => range.head)).toEqual([3, 11]);
  });

  it("carries a corrected edit's effects over to the rewritten changes", () => {
    const mark = StateEffect.define<number>({ map: (pos, mapping) => mapping.mapPos(pos) });
    let seen: number | null = null;
    const state = EditorState.create({
      doc: "# Plan\nline2",
      extensions: [
        titleLine("Plan"),
        EditorState.transactionExtender.of((tr) => {
          for (const effect of tr.effects) if (effect.is(mark)) seen = effect.value;
          return null;
        }),
      ],
    });
    // A paste over the title's line break, with an effect naming the end of the pasted text.
    state.update({ changes: { from: 4, to: 8, insert: "XY" }, effects: mark.of(6), userEvent: "input.paste" });
    // Rewritten to "# PlXY\nine2", the line break kept. The effect named the
    // end of what the paste covered, which is now just after that line break.
    expect(seen).toBe(7);
  });

  it("undoes and redoes a corrected edit as one step", () => {
    const pasted = edit(make(`# Plan${BODY}`), {
      changes: { from: 2, to: 6, insert: "A\nB" },
      userEvent: "input.paste",
    }).state;
    expect(pasted.doc.toString()).toBe(`# A\nB\n${BODY.slice(1)}`);
    const undone = run(pasted, undo);
    expect(undone.text).toBe(`# Plan${BODY}`);
    expect(run(undone.state, redo).text).toBe(`# A\nB\n${BODY.slice(1)}`);
  });

  describe("how line 1 shows", () => {
    /** The decorations' specs: the line class, or the preview widget's title. */
    const shown = (state: EditorState) => {
      const found: string[] = [];
      titleLineDecorations(state).between(0, state.doc.length, (_from, _to, deco) => {
        const spec = deco.spec as { class?: string; widget?: { title: string } };
        found.push(spec.widget ? `preview:${spec.widget.title}` : `line:${spec.class}`);
      });
      return found;
    };

    it("styles line 1 as the note's title", () => {
      expect(shown(make(`# Plan${BODY}`))).toEqual(["line:cm-title-line"]);
      expect(shown(make(`# Plan${BODY}`, { readOnly: true }))).toEqual(["line:cm-title-line"]);
    });

    it("shows a note that does not open with its title line the one it will get, writing nothing", () => {
      for (const readOnly of [true, false]) {
        for (const doc of [`Prose${BODY}`, `## Plan${BODY}`, ""]) {
          const state = make(doc, { readOnly });
          expect(shown(state), doc).toEqual(["preview:Plan"]);
          expect(state.doc.toString()).toBe(doc);
        }
      }
    });

    it("shows the preview over a level-1 heading that says something else: that is content, not the title line", () => {
      for (const readOnly of [true, false]) {
        expect(shown(make(`# Introduction${BODY}`, { readOnly }))).toEqual(["preview:Plan"]);
      }
      // Its title line written exactly, for a title that reads differently once cleaned.
      const week = EditorState.create({ doc: `# Week #${BODY}`, extensions: [titleLine("Week #")] });
      expect(shown(week)).toEqual(["line:cm-title-line"]);
    });
  });
});
