import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { external, readOnlyGuard } from "@/components/vault/live-editor/read-only";
import { enterFromTitle, titleLine, titleLineChange, titleLineDecorations } from "@/components/vault/live-editor/title-line";

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

    it("inline formatting over a selection that starts in the `# ` wraps the title", () => {
      const after = edit(make(`# Plan${BODY}`), {
        changes: [
          { from: 0, insert: "**" },
          { from: 6, insert: "**" },
        ],
        userEvent: "input.format",
      });
      expect(after.text).toBe(`# **Plan**${BODY}`);
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

    it("shows a read-only copy that does not open with its title the title line it will get, writing nothing", () => {
      for (const doc of [`Prose${BODY}`, `## Plan${BODY}`, `# Other${BODY}`, ""]) {
        const state = make(doc, { readOnly: true });
        expect(shown(state), doc).toEqual(["preview:Plan"]);
        expect(state.doc.toString()).toBe(doc);
      }
    });

    it("shows no preview on a copy that can be edited: it gets the real line", () => {
      expect(shown(make(`Prose${BODY}`))).toEqual([]);
    });
  });
});
