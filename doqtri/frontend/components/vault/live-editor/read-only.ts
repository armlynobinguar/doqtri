import { Annotation, EditorState } from "@codemirror/state";

/** Marks the transactions that load text from outside, so they are not echoed back. */
export const external = Annotation.define<boolean>();

/**
 * Read-only means no edits from anywhere but outside: not a key, a paste, a
 * completion or a checkbox. CodeMirror's own readOnly facet only stops typed
 * input; this drops every other change while the state is read-only, unless
 * it is text loaded from outside (a reload, someone else's save).
 */
export const readOnlyGuard = EditorState.changeFilter.of(
  (tr) => !tr.startState.readOnly || tr.annotation(external) === true,
);
