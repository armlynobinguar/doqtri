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
import { hasTitleLine } from "@/lib/title-line";
import { external } from "@/components/vault/live-editor/read-only";

/**
 * The note's title line in the editor (D-120). Like Obsidian's, the first
 * line is always `# <title>`: editing its text renames the note (DOQ-36),
 * but the line itself is not content that can be removed. lib/title-line.ts
 * says what an older note's line is (the editor adds it with the note's
 * first edit); this keeps it there.
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
 *   - commands that move or copy whole lines, swap characters, or restyle a
 *     block (Alt-↑/↓, Ctrl-T, the toolbar's headings, lists, quotes and code
 *     blocks) do nothing when they would reach line 1; inline formatting
 *     inside the title's text still works
 *
 * Only edits from this editor are checked: text loaded from outside (a
 * reload, someone else's save) is shown as it is, and undo and redo replay
 * edits that were already checked. A note whose first line is not a title
 * line yet (an older note not edited since D-120, or one whose headings are
 * linked or anchored and so never gets one) is not guarded either; it shows
 * its title above the text instead (see TitlePreview), writing nothing.
 */

/** A first line that is a title line: `#`, then a space or tab. Its first two characters are the prefix. */
const TITLE_LINE_RE = /^#[ \t]/;
const PREFIX = 2;

/** Marks this editor's own title line changes: Enter on the title, and the line added with a first edit. */
export const titleLineChange = Annotation.define<boolean>();

/** Tells the editor the note's title, for the title line shown above a note that has none yet. */
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
    } else if (from < PREFIX && to <= PREFIX && more.length > 0 && more[more.length - 1] === "") {
      // Whole lines put above the title (they end in a line break): they go
      // to the start of the body instead, the title line untouched.
      rest.push(...lines.slice(0, -1));
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

/** Commands that move or copy whole lines, by their user events. */
const LINE_MOVES = ["move.line", "input.copyline"];

/** Whether an edit reaches line 1: its text, its `# `, or the line break after it. */
const touchesTitle = (edit: Edit, titleEnd: number) => edit.from <= titleEnd;

/** Whether an edit reaches into the `# ` or across the line break after the title. */
const crossesTitle = (edit: Edit, titleEnd: number) =>
  edit.from <= titleEnd && (edit.from < PREFIX || edit.to > titleEnd);

/** Whether an edit stays inside the title's text, on one line: an inline wrap such as bold. */
const insideTitleText = (edit: Edit, titleEnd: number) =>
  edit.from >= PREFIX && edit.to <= titleEnd && edit.lines.length === 1;

/**
 * The guard itself: rewrites an edit that would break the title line into
 * one that keeps it (see repairTitleLine), and drops the ones with nothing
 * sensible to rewrite into: line moves and copies that reach line 1,
 * character swaps across its `# ` or line break, and toolbar block styles on
 * it (anything but an inline wrap of its text).
 *
 * A rewrite keeps the transaction's user event and whether it goes into undo
 * history, and carries its effects over to the rewritten changes. A single
 * caret goes where repairTitleLine says; several are each mapped through the
 * rewritten changes, so none is lost.
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
  const titleEnd = start.doc.line(1).to;
  if (LINE_MOVES.some((event) => tr.isUserEvent(event)) && edits.some((edit) => touchesTitle(edit, titleEnd))) {
    return {};
  }
  // Ctrl-T: swapping across the `# ` or the title's line break; inside the title it swaps as usual.
  if (tr.isUserEvent("move.character") && edits.some((edit) => crossesTitle(edit, titleEnd))) return {};
  const format = tr.isUserEvent("input.format");
  if (format && edits.some((edit) => touchesTitle(edit, titleEnd) && !insideTitleText(edit, titleEnd))) return {};

  const repaired = repairTitleLine(start.doc, edits, format);
  if (!repaired) return guarded(tr.newDoc) ? tr : {};
  if (!guarded(repaired.changes.apply(start.doc))) return {};
  if (repaired.changes.empty && repaired.caret === null) return {};

  const userEvent = tr.annotation(Transaction.userEvent);
  const annotations: Annotation<boolean | string>[] = [
    Transaction.addToHistory.of(tr.annotation(Transaction.addToHistory) ?? true),
  ];
  if (userEvent) annotations.push(Transaction.userEvent.of(userEvent));
  // Effects name positions in the text the original changes made: back to
  // the text before them, then on through the rewritten ones.
  const back = tr.changes.invertedDesc;
  const effects = tr.effects
    .map((effect) => effect.map(back)?.map(repaired.changes.desc))
    .filter((effect): effect is StateEffect<unknown> => effect !== undefined);
  // Several carets: each where it was, moved out of the `# ` (where typing
  // goes to the start of the title), then mapped past what was typed there.
  const clamp = (pos: number) => Math.max(pos, PREFIX);
  const selection =
    start.selection.ranges.length > 1
      ? EditorSelection.create(
          start.selection.ranges.map((range) =>
            EditorSelection.range(clamp(range.anchor), clamp(range.head)).map(repaired.changes, 1),
          ),
          start.selection.mainIndex,
        )
      : repaired.caret === null
        ? undefined
        : EditorSelection.cursor(repaired.caret);
  return { changes: repaired.changes, selection, effects, annotations, scrollIntoView: true };
});

/**
 * Alt-↑/↓ and Shift-Alt-↑/↓ move or copy the selected lines. Not when the
 * lines include the title line, or when moving line 2 up would swap it with
 * the title: the guard would drop the edit anyway, so the keys are taken
 * here and do nothing.
 */
function refuseLineMove(up: boolean, move: boolean) {
  return (view: { state: EditorState }): boolean => {
    const { state } = view;
    if (state.readOnly || !guarded(state.doc)) return false;
    return state.selection.ranges.some((range) => {
      const first = state.doc.lineAt(range.from).number;
      return first === 1 || (up && move && first === 2);
    });
  };
}

/** The line move and copy keys' guards, in the order of their bindings. */
export const lineMoveKeys = {
  moveUp: refuseLineMove(true, true),
  moveDown: refuseLineMove(false, true),
  copyUp: refuseLineMove(true, false),
  copyDown: refuseLineMove(false, false),
};

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

/** The title shown above a note's text while the text does not open with it. */
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
 * Line 1 is styled as the note's title. A note that does not open with its
 * title line shows the one it will get, above the text and outside it:
 * nothing is written for it until the note's first edit (and never, for a
 * note whose headings are linked or anchored).
 */
export function titleLineDecorations(state: EditorState): DecorationSet {
  const title = state.field(titleField);
  if (title.trim() && !hasTitleLine(state.doc.toString(), title)) {
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
    if (!tr.docChanged && !titleChanged) return value;
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
    Prec.highest(
      keymap.of([
        { key: "Enter", run: enterFromTitle, shift: enterFromTitle },
        { key: "Alt-ArrowUp", run: lineMoveKeys.moveUp },
        { key: "Alt-ArrowDown", run: lineMoveKeys.moveDown },
        { key: "Shift-Alt-ArrowUp", run: lineMoveKeys.copyUp },
        { key: "Shift-Alt-ArrowDown", run: lineMoveKeys.copyDown },
      ]),
    ),
  ];
}
