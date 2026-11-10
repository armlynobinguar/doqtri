import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { opensWithTitle } from "@/lib/heading-rename";
import { external } from "@/components/vault/live-editor/read-only";

/**
 * The note's title line in the editor (D-120). Like Obsidian's, the first
 * line is always `# <title>`: editing its text renames the note (DOQ-36),
 * but the line itself is not content that can be removed. lib/title-line.ts
 * puts it there when a note opens without one; this keeps it there.
 *
 * Every edit is let through as it is unless it would break the line, and
 * then it is corrected rather than refused, so typing still lands somewhere
 * sensible:
 *   - the `# ` stays: deleting it, typing over it or turning it into `##` or
 *     a list leaves it as it was (text typed before it goes into the title)
 *   - the title is never merged with the line below: Backspace at the start
 *     of line 2 and Delete at the end of line 1 do nothing, and a selection
 *     from the title into the body deletes both parts but keeps the line
 *     break between them
 *   - the title never splits: Enter on it moves the caret to the start of
 *     the body (adding a line when the note has none), and text pasted into
 *     it keeps its first line in the title and puts the rest at the start of
 *     the body
 *   - replacing the whole note (select all, then type, delete or paste)
 *     leaves `# ` with an empty title, which renames nothing (DOQ-36's
 *     "emptied"), and the new text below it; a pasted note that opens with
 *     its own `# ` heading brings its own title
 *
 * Only edits from this editor are checked: text loaded from outside (a
 * reload, someone else's save) is shown as it is, and undo and redo replay
 * edits that were already checked. A note whose first line is not a title
 * line yet (a read-only copy of an older note) is not guarded either; it
 * shows its title above the text instead (see `preview`), and gets the real
 * line once it can be edited.
 */

/** A first line that is a title line: `#`, then a space or tab. Its first two characters are the prefix. */
const TITLE_LINE_RE = /^#[ \t]/;
const PREFIX = 2;

/** Marks this editor's own title line changes: Enter on the title, and the line added on open. */
export const titleLineChange = Annotation.define<boolean>();

/** Tells the editor the note's title, for the title line shown above a read-only copy's text. */
export const setNoteTitle = StateEffect.define<string>();

const titleField = StateField.define<string>({
  create: () => "",
  update(title, tr) {
    for (const effect of tr.effects) if (effect.is(setNoteTitle)) title = effect.value;
    return title;
  },
});

/** Whether line 1 is the title line, so the guard keeps it. */
function guarded(doc: Text): boolean {
  return TITLE_LINE_RE.test(doc.line(1).text);
}

/** One change of a transaction, in the coordinates of the text before it, with its inserted lines. */
type Edit = { from: number; to: number; lines: string[] };

/** One change to make instead, and where it sorts among changes at the same place. */
type Out = { from: number; to: number; insert: string; rank: number };

/** Block markup a toolbar command puts at the start of a line: none of it belongs before the title. */
const BLOCK_MARKUP_ONLY = /^[ \t]*(#{1,6}|>|[-*+](?: \[[ xX]\])?|\d+[.)])?[ \t]*$/;

/** A pasted first line that is a level-1 heading of its own. */
const H1_LINE = /^#(?:[ \t]|$)/;

/**
 * The changes that keep the title line whole in place of `edits`, and where
 * the caret goes, or null when none of them touches the title line in a way
 * that breaks it. `doc` is the text before the edits, and opens with a title
 * line. A null caret leaves the selection where it was: an edit that comes
 * to nothing, like Backspace at the start of line 2.
 */
export function repairTitleLine(
  doc: Text,
  edits: readonly Edit[],
  format = false,
): { changes: ChangeSet; caret: number | null } | null {
  const titleEnd = doc.line(1).to;
  const length = doc.length;
  const hasBody = doc.lines > 1;

  const breaks = (edit: Edit) =>
    edit.from <= titleEnd && (edit.from < PREFIX || edit.to > titleEnd || edit.lines.length > 1);
  if (!edits.some(breaks)) return null;

  const out: Out[] = [];
  const rest: string[] = [];
  // Where the caret goes: the end of one of the changes, or the start of the body.
  let caret: Out | "body" | null = null;
  const push = (from: number, to: number, insert: string): Out | null => {
    if (from === to && insert === "") return null;
    const change = { from, to, insert, rank: 0 };
    out.push(change);
    return change;
  };

  /**
   * The title from `from` to its end becomes `title`, and the part of the
   * edit past the line break (up to `to`) becomes `body`. The line break
   * stays, unless the edit went to the end of the note and left nothing
   * after the title: then there is nothing to keep apart.
   */
  const span = (from: number, to: number, title: string, body: string[]) => {
    const bodyText = body.join("\n");
    if (to > titleEnd) {
      if (to === length && bodyText === "") {
        caret = push(from, length, title) ?? caret;
      } else {
        // The caret ends after what was typed: in the body when some of it
        // went there, else in the title, where the selection started.
        const titlePart = push(from, titleEnd, title);
        const bodyPart = push(titleEnd + 1, to, bodyText);
        caret = (bodyText !== "" ? bodyPart : (titlePart ?? bodyPart)) ?? caret;
      }
    } else {
      caret = push(from, titleEnd, title) ?? caret;
      if (bodyText !== "") rest.push(...body);
    }
  };

  for (const edit of edits) {
    const { from, to, lines } = edit;
    const [first, ...more] = lines;
    if (from > titleEnd) {
      // In the body: as it is.
      caret = push(from, to, lines.join("\n")) ?? caret;
    } else if (from < PREFIX && to === length && to > PREFIX) {
      // The whole note replaced: select all, then type, delete or paste. A
      // pasted note that opens with a level-1 heading brings its own title;
      // anything else goes below an empty one.
      if (H1_LINE.test(first)) span(PREFIX, to, first.replace(/^#[ \t]*/, ""), more);
      else span(PREFIX, to, "", lines);
    } else if (from < PREFIX && to > titleEnd) {
      // From inside the `# ` into the body: the title line selected with its
      // line break, say. The `# ` and the line break stay; what is typed goes
      // into the title, as below.
      span(PREFIX, to, first.replace(/^[#\s]*/, ""), more);
    } else if (from < PREFIX) {
      // Inside the `# `: it stays, and anything typed goes to the start of
      // the title, without the `#`s and spaces that would only make it `##`.
      const typed = format && BLOCK_MARKUP_ONLY.test(first) ? "" : first.replace(/^[#\s]*/, "");
      caret = push(PREFIX, Math.max(to, PREFIX), typed) ?? caret;
      if (more.length > 0) rest.push(...more);
    } else if (to > titleEnd) {
      // From the title across the line break into the body.
      span(from, to, first, more);
    } else if (more.length > 0) {
      // A line break typed or pasted into the title: the first line stays.
      caret = push(from, to, first) ?? caret;
      rest.push(...more);
    } else {
      caret = push(from, to, first) ?? caret;
    }
  }

  // How far before the end of the caret's change it goes.
  let back = 0;
  // What would have split the title off goes to the start of the body. A
  // lone line break (Enter, as a phone's keyboard may send it) moves there.
  if (rest.length > 0) {
    const lone = rest.length === 1 && rest[0] === "";
    if (hasBody) {
      if (lone) caret = "body";
      else {
        // Before the line break that keeps it apart from what was there.
        const change = push(titleEnd + 1, titleEnd + 1, `${rest.join("\n")}\n`);
        if (change) change.rank = -1;
        caret = change;
        back = 1;
      }
    } else {
      const change = push(titleEnd, titleEnd, `\n${lone ? "" : rest.join("\n")}`);
      if (change) change.rank = 1;
      caret = change;
    }
  }

  const sorted = out
    .map((change, index) => ({ change, index }))
    .sort((a, b) => a.change.from - b.change.from || a.change.rank - b.change.rank || a.index - b.index)
    .map(({ change }) => change);
  const changes = ChangeSet.of(
    sorted.map(({ from, to, insert }) => ({ from, to, insert })),
    length,
  );

  let at: number | null;
  if (caret === "body") {
    at = changes.mapPos(titleEnd + 1, -1);
  } else if (caret) {
    // The end of that change's text, counting what the changes before it added or removed.
    let shift = 0;
    for (const change of sorted) {
      if (change === caret) break;
      shift += change.insert.length - (change.to - change.from);
    }
    at = caret.from + shift + caret.insert.length - back;
  } else {
    at = null;
  }
  return { changes, caret: at };
}

/**
 * The guard itself: rewrites an edit that would break the title line into
 * one that keeps it (see repairTitleLine), and drops one that cannot be
 * rewritten into anything sensible.
 */
const guard = EditorState.transactionFilter.of((tr): Transaction | TransactionSpec | readonly TransactionSpec[] => {
  if (!tr.docChanged) return tr;
  if (tr.annotation(external) || tr.annotation(titleLineChange)) return tr;
  if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return tr;
  const start = tr.startState;
  if (start.readOnly || !guarded(start.doc)) return tr;

  const edits: Edit[] = [];
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    edits.push({ from, to, lines: inserted.toJSON() });
  });
  const repaired = repairTitleLine(start.doc, edits, tr.isUserEvent("input.format"));
  if (!repaired) return guarded(tr.newDoc) ? tr : {};
  if (!guarded(repaired.changes.apply(start.doc))) return {};

  const userEvent = tr.annotation(Transaction.userEvent);
  const annotations: Annotation<boolean | string>[] = [
    Transaction.addToHistory.of(tr.annotation(Transaction.addToHistory) ?? true),
  ];
  if (userEvent) annotations.push(Transaction.userEvent.of(userEvent));
  if (repaired.changes.empty && repaired.caret === null) return {};
  return {
    changes: repaired.changes,
    selection: repaired.caret === null ? undefined : EditorSelection.cursor(repaired.caret),
    effects: tr.effects,
    annotations,
    scrollIntoView: true,
  };
});

/**
 * Enter on the title line moves the caret to the start of the body, adding a
 * line for it when the note has nothing under its title. A selection inside
 * the title is left as it is: Enter never deletes the title's text. With the
 * link list open, Enter is the list's.
 */
export function enterFromTitle(view: { state: EditorState; dispatch: (spec: TransactionSpec) => void }): boolean {
  const { state } = view;
  if (state.readOnly || !guarded(state.doc)) return false;
  if (completionStatus(state) === "active") return false;
  const title = state.doc.line(1);
  const { main } = state.selection;
  if (main.to > title.to) return false;
  if (state.doc.lines > 1) {
    view.dispatch({ selection: EditorSelection.cursor(title.to + 1), scrollIntoView: true, userEvent: "select" });
  } else {
    view.dispatch({
      changes: { from: title.to, insert: "\n" },
      selection: EditorSelection.cursor(title.to + 1),
      scrollIntoView: true,
      userEvent: "input",
      annotations: titleLineChange.of(true),
    });
  }
  return true;
}

/** The title shown above a read-only copy's text when the text does not open with it yet. */
class TitlePreview extends WidgetType {
  constructor(readonly title: string) {
    super();
  }

  eq(other: TitlePreview) {
    return other.title === this.title;
  }

  toDOM() {
    const line = document.createElement("div");
    line.className = "cm-title-preview";
    line.dataset.testid = "title-line-preview";
    line.textContent = this.title;
    return line;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Line 1 is styled as the note's title. A copy that cannot be written to
 * (read-only, Reading view, or waiting for its lock) whose text does not open
 * with the title yet shows the title line it will get, above the text and
 * outside it: nothing is written until the note can be edited.
 */
export function titleLineDecorations(state: EditorState): DecorationSet {
  const title = state.field(titleField);
  if (state.readOnly && title.trim() && !opensWithTitle(state.doc.toString(), title)) {
    return Decoration.set([
      Decoration.widget({ widget: new TitlePreview(title.trim()), block: true, side: -1 }).range(0),
    ]);
  }
  if (!guarded(state.doc)) return Decoration.none;
  return Decoration.set([Decoration.line({ class: "cm-title-line" }).range(0)]);
}

const decorations = StateField.define<DecorationSet>({
  create: titleLineDecorations,
  update(value, tr) {
    const titleChanged = tr.effects.some((effect) => effect.is(setNoteTitle));
    if (!tr.docChanged && !titleChanged && tr.startState.readOnly === tr.state.readOnly) return value;
    return titleLineDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The title line, for an editor showing a note titled `title`. */
export function titleLine(title: string): Extension {
  return [
    titleField.init(() => title),
    decorations,
    guard,
    Prec.highest(keymap.of([{ key: "Enter", run: enterFromTitle, shift: enterFromTitle }])),
  ];
}
