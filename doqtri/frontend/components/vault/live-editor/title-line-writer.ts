import { Transaction, type EditorState, type TransactionSpec } from "@codemirror/state";
import { hasTitleLine, titleLineEdit } from "@/lib/title-line";
import type { TitleLineSafety } from "@/lib/title-line-safety";
import { guarded, titleLineChange } from "@/components/vault/live-editor/title-line";

/**
 * Gives an older note its title line with its first edit (D-120,
 * lib/title-line.ts). Opening a note writes nothing; the first edit applies
 * at once, as any edit does, and then:
 *
 *   1. if the note still lacks its title line (and the guard holds none:
 *      a title being retyped is still the title line), the workspace is asked afresh
 *      whether the line may go in (lib/title-line-safety.ts: not when its
 *      headings are linked or it is registered or anchored on chain). Nothing
 *      is remembered from earlier, so a link or anchor made since counts;
 *   2. only on "allowed", and only if the text still lacks the line, the copy
 *      can still be edited and the confirmed title is still the one asked
 *      with, `# <title>` goes in at the very top: its own change, outside undo
 *      history, every caret moved along with the text.
 *
 * One answer per loaded text: after "blocked" (or a failed read) nothing is
 * asked again until text is loaded from outside, which starts over. While a
 * rename is still on its way (no confirmed title) nothing is asked, and the
 * next edit tries again.
 */

/** What the workspace says, read at the moment it is needed. */
export type TitleLineWrite = {
  /** The confirmed title to write, or null while a rename is on its way. */
  title: string | null;
  /** Asks afresh whether the line may go in. */
  check(): Promise<TitleLineSafety>;
};

/** Where the writer stands, for the editor's `data-title-line`. */
export type TitleLineWriterState = "idle" | "checking" | "added" | "blocked";

/** The part of an EditorView the writer needs. */
export type WriterView = { readonly state: EditorState; dispatch(spec: TransactionSpec): void };

/**
 * Puts the title line in now: its own change at the top, outside undo
 * history, every caret and selection moved with the text. Returns the text it
 * made, or null when there is nothing to add or the copy cannot be edited.
 */
export function addTitleLine(view: WriterView, title: string): string | null {
  const { state } = view;
  if (state.readOnly) return null;
  const edit = titleLineEdit(state.doc.toString(), title);
  if (!edit) return null;
  const changes = state.changes(edit);
  view.dispatch({
    changes,
    selection: state.selection.map(changes, 1),
    annotations: [titleLineChange.of(true), Transaction.addToHistory.of(false)],
  });
  return view.state.doc.toString();
}

export function createTitleLineWriter(options: {
  /** The workspace's current word, or undefined when the editor has no title line at all. */
  write(): TitleLineWrite | undefined;
  /** The line went in, with this text. */
  onAdded?(markdown: string): void;
  onState?(state: TitleLineWriterState): void;
}) {
  let decided = false;
  // Bumped by reset(), so an answer for text since replaced is dropped.
  let generation = 0;
  const setState = (state: TitleLineWriterState) => options.onState?.(state);

  return {
    /** A user edit just applied to `view` (not one loaded from outside, nor the writer's own). */
    edited(view: WriterView) {
      if (decided) return;
      const write = options.write();
      if (!write || write.title === null) return;
      const title = write.title;
      // A title line the guard holds is the note's, even while it is being
      // retyped and says something else for a moment.
      if (guarded(view.state) || hasTitleLine(view.state.doc.toString(), title)) {
        decided = true;
        return;
      }
      decided = true;
      const asked = ++generation;
      setState("checking");
      write.check().then(
        (safety) => {
          if (asked !== generation) return;
          if (safety !== "allowed") {
            setState("blocked");
            return;
          }
          if (options.write()?.title !== title) {
            // Renamed meanwhile: the next edit asks again, with the new title.
            decided = false;
            setState("idle");
            return;
          }
          const added = addTitleLine(view, title);
          setState(added === null ? "idle" : "added");
          if (added !== null) options.onAdded?.(added);
        },
        () => {
          if (asked === generation) setState("blocked");
        },
      );
    },

    /** Text was loaded from outside: the next edit decides again. */
    reset() {
      decided = false;
      generation++;
      setState("idle");
    },
  };
}

export type TitleLineWriter = ReturnType<typeof createTitleLineWriter>;
