import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { external, readOnlyGuard } from "@/components/vault/live-editor/read-only";
import { acceptLink, completeWith } from "@/components/vault/live-editor/wikilink-completion";

const state = (doc: string, readOnly: boolean) =>
  EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: [EditorState.readOnly.of(readOnly), readOnlyGuard],
  });

describe("readOnlyGuard", () => {
  it("drops an edit made to a read-only note: a paste, a completion, a checkbox", () => {
    const locked = state("- [ ] todo", true);
    for (const userEvent of ["input.paste", "input.complete", "input.toggle", undefined]) {
      const next = locked.update({ changes: { from: 3, to: 4, insert: "x" }, userEvent }).state;
      expect(next.doc.toString(), String(userEvent)).toBe("- [ ] todo");
    }
  });

  it("lets text loaded from outside through, read-only or not", () => {
    const next = state("old", true).update({
      changes: { from: 0, to: 3, insert: "theirs" },
      annotations: external.of(true),
    }).state;
    expect(next.doc.toString()).toBe("theirs");
  });

  it("does nothing to an editable note", () => {
    expect(state("abc", false).update({ changes: { from: 3, insert: "d" } }).state.doc.toString()).toBe("abcd");
  });
});

describe("link completion on a read-only note", () => {
  const titles = () => ["Qzalpha Alpha target"];

  it("neither accepts nor completes, and sends nothing", () => {
    const dispatch = vi.fn();
    const view = { state: state("see [[Qz", true), dispatch } as unknown as EditorView;
    expect(acceptLink(titles)(view)).toBe(false);
    expect(completeWith(view, { start: 6, query: "Qz" }, "Qzalpha Alpha target")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("completes on an editable one", () => {
    const dispatch = vi.fn();
    const view = { state: state("see [[Qz", false), dispatch } as unknown as EditorView;
    expect(completeWith(view, { start: 6, query: "Qz" }, "Qzalpha Alpha target")).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
