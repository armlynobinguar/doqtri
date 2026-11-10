import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { titleLine } from "@/components/vault/live-editor/title-line";
import { createTitleLineWriter, type TitleLineWrite } from "@/components/vault/live-editor/title-line-writer";
import type { TitleLineSafety } from "@/lib/title-line-safety";

/** Enough of an EditorView: dispatch applies specs and transactions alike, as the view does. */
class FakeView {
  constructor(public state: EditorState) {}
  dispatch = (spec: TransactionSpec | Transaction) => {
    this.state = (spec instanceof Transaction ? spec : this.state.update(spec)).state;
  };
  get text() {
    return this.state.doc.toString();
  }
}

function viewOf(doc: string, { caret = doc.length, multiple = false, readOnly = false } = {}) {
  return new FakeView(
    EditorState.create({
      doc,
      selection: EditorSelection.cursor(caret),
      extensions: [
        history(),
        titleLine("Plan"),
        EditorState.allowMultipleSelections.of(multiple),
        EditorState.readOnly.of(readOnly),
      ],
    }),
  );
}

/** A check whose answer the test gives, and how often it was asked. */
function deferredCheck() {
  let answer!: (safety: TitleLineSafety) => void;
  const check = vi.fn(() => new Promise<TitleLineSafety>((resolve) => (answer = resolve)));
  return { check, answer: (safety: TitleLineSafety) => answer(safety) };
}

/** A writer driven like the editor drives it, with the workspace's word in `write`. */
function writerFor(write: { current: TitleLineWrite | undefined }) {
  const added: string[] = [];
  const states: string[] = [];
  const writer = createTitleLineWriter({
    write: () => write.current,
    onAdded: (markdown) => added.push(markdown),
    onState: (state) => states.push(state),
  });
  return { writer, added, states };
}

/** Types `text` at the caret, as the user would, and tells the writer. */
function type(view: FakeView, writer: ReturnType<typeof createTitleLineWriter>, text: string) {
  view.dispatch(view.state.update(view.state.replaceSelection(text), { userEvent: "input.type" }));
  writer.edited(view);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the title line added after a first edit (D-120)", () => {
  it("adds nothing until an edit, then the line above it once a fresh check allows it", async () => {
    const view = viewOf("Prose\n\nBody");
    const { check, answer } = deferredCheck();
    const { writer, added, states } = writerFor({ current: { title: "Plan", check } });
    await settle();
    expect(check).not.toHaveBeenCalled();
    expect(view.text).toBe("Prose\n\nBody");

    type(view, writer, " more");
    // The edit applies at once; the line waits for the answer.
    expect(view.text).toBe("Prose\n\nBody more");
    expect(states).toEqual(["checking"]);
    answer("allowed");
    await settle();
    expect(view.text).toBe("# Plan\n\nProse\n\nBody more");
    expect(added).toEqual(["# Plan\n\nProse\n\nBody more"]);
    expect(states).toEqual(["checking", "added"]);
    // The caret moved with the text: typing goes on where it was.
    type(view, writer, "!");
    expect(view.text).toBe("# Plan\n\nProse\n\nBody more!");
    expect(check).toHaveBeenCalledOnce();
  });

  it("keeps the line out of undo history: undo takes the edit back and leaves the line", async () => {
    const view = viewOf("Prose");
    const { writer } = writerFor({ current: { title: "Plan", check: async () => "allowed" } });
    type(view, writer, " more");
    await settle();
    expect(view.text).toBe("# Plan\n\nProse more");
    undo(view);
    expect(view.text).toBe("# Plan\n\nProse");
    redo(view);
    expect(view.text).toBe("# Plan\n\nProse more");
  });

  it("writes nothing when the fresh check says blocked, and asks nothing more until text is reloaded", async () => {
    const view = viewOf("Prose");
    const check = vi.fn(async (): Promise<TitleLineSafety> => "blocked");
    const { writer, states } = writerFor({ current: { title: "Plan", check } });
    type(view, writer, " a");
    await settle();
    type(view, writer, " b");
    await settle();
    expect(view.text).toBe("Prose a b");
    expect(check).toHaveBeenCalledOnce();
    expect(states).toEqual(["checking", "blocked"]);

    // Reloaded text: the next edit asks afresh, and this time it is allowed.
    check.mockResolvedValueOnce("allowed");
    writer.reset();
    type(view, writer, " c");
    await settle();
    expect(view.text).toBe("# Plan\n\nProse a b c");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("asks afresh each time: an answer from before a reload is dropped", async () => {
    const view = viewOf("Prose");
    const first = deferredCheck();
    const write = { current: { title: "Plan", check: first.check } as TitleLineWrite };
    const { writer } = writerFor(write);
    type(view, writer, " a");
    writer.reset();
    // A link was made meanwhile: the fresh answer is blocked.
    const second = deferredCheck();
    write.current = { title: "Plan", check: second.check };
    type(view, writer, " b");
    first.answer("allowed");
    second.answer("blocked");
    await settle();
    expect(view.text).toBe("Prose a b");
  });

  it("treats a check that cannot be read, or that is still loading, as no", async () => {
    for (const check of [async () => Promise.reject(new Error("offline")), async (): Promise<TitleLineSafety> => "loading"]) {
      const view = viewOf("Prose");
      const { writer, states } = writerFor({ current: { title: "Plan", check } });
      type(view, writer, " a");
      await settle();
      expect(view.text).toBe("Prose a");
      expect(states.at(-1)).toBe("blocked");
    }
  });

  it("waits while a rename is on its way, and asks with the confirmed title at the next edit", async () => {
    const view = viewOf("Prose");
    const check = vi.fn(async (): Promise<TitleLineSafety> => "allowed");
    const write: { current: TitleLineWrite } = { current: { title: null, check } };
    const { writer } = writerFor(write);
    type(view, writer, " a");
    await settle();
    expect(check).not.toHaveBeenCalled();
    expect(view.text).toBe("Prose a");
    write.current = { title: "Plan", check };
    type(view, writer, " b");
    await settle();
    expect(view.text).toBe("# Plan\n\nProse a b");
  });

  it("does not write a title that changed while it was asked; the next edit asks again", async () => {
    const view = viewOf("Prose");
    const { check, answer } = deferredCheck();
    const write: { current: TitleLineWrite } = { current: { title: "Plan", check } };
    const { writer } = writerFor(write);
    type(view, writer, " a");
    write.current = { title: null, check };
    answer("allowed");
    await settle();
    expect(view.text).toBe("Prose a");
  });

  it("writes nothing into a copy that can no longer be edited, or that gained its title line meanwhile", async () => {
    const locked = viewOf("Prose", { readOnly: true });
    const ask = vi.fn(async (): Promise<TitleLineSafety> => "allowed");
    const { writer: lockedWriter } = writerFor({ current: { title: "Plan", check: ask } });
    lockedWriter.edited(locked);
    await settle();
    expect(locked.text).toBe("Prose");

    const titled = viewOf("# Plan\n\nProse");
    const { writer } = writerFor({ current: { title: "Plan", check: ask } });
    type(titled, writer, " a");
    await settle();
    expect(titled.text).toBe("# Plan\n\nProse a");
    expect(ask).toHaveBeenCalledOnce();
  });

  it("never adds a line above a title line being retyped, though it says something else for a moment", async () => {
    const view = viewOf("# Plan\n\nBody", { caret: 6 });
    const check = vi.fn(async (): Promise<TitleLineSafety> => "allowed");
    const { writer } = writerFor({ current: { title: "Plan", check } });
    view.dispatch(view.state.update({ changes: { from: 2, to: 6, insert: "T" }, userEvent: "input.type" }));
    writer.edited(view);
    await settle();
    expect(view.text).toBe("# T\n\nBody");
    expect(check).not.toHaveBeenCalled();
  });

  it("moves every caret with the line it adds", async () => {
    const view = viewOf("ab\ncd", { multiple: true });
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(4)]) });
    const { writer } = writerFor({ current: { title: "Plan", check: async () => "allowed" } });
    type(view, writer, "x");
    await settle();
    expect(view.text).toBe("# Plan\n\naxb\ncxd");
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([10, 14]);
  });
});

describe("undo after the title line was added (D-120)", () => {
  /** Opens `doc`, applies the first edit, adds the line as the writer does, then undoes and redoes. */
  async function probe(doc: string, edit: TransactionSpec) {
    const view = viewOf(doc);
    const { writer } = writerFor({ current: { title: "Plan", check: async () => "allowed" } });
    view.dispatch(view.state.update(edit));
    writer.edited(view);
    await settle();
    const added = view.text;
    undo(view);
    const undone = view.text;
    redo(view);
    return { added, undone, redone: view.text };
  }

  it("puts text undone back to the top below the title line, never into it", async () => {
    expect(await probe("Intro para\n\n## A", { changes: { from: 0, to: 16 }, userEvent: "delete" })).toEqual({
      added: "# Plan\n",
      undone: "# Plan\nIntro para\n\n## A",
      redone: "# Plan\n",
    });
    expect(await probe("Hello\n\nBody", { changes: { from: 0, to: 5 }, userEvent: "delete" })).toEqual({
      added: "# Plan\n\n\nBody",
      undone: "# Plan\nHello\n\nBody",
      redone: "# Plan\n\n\nBody",
    });
    expect(await probe("Hello", { changes: { from: 0, to: 5 }, userEvent: "delete" })).toEqual({
      added: "# Plan\n",
      undone: "# Plan\nHello",
      redone: "# Plan\n",
    });
    expect(await probe("#\n\nbody", { changes: { from: 0, to: 1 }, userEvent: "delete" })).toEqual({
      added: "# Plan\n\n\nbody",
      undone: "# Plan\n#\n\nbody",
      redone: "# Plan\n\n\nbody",
    });
  });
});
