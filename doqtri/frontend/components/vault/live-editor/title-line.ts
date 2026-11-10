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
import { isolateHistory } from "@codemirror/commands";
import { hasTitleLine } from "@/lib/title-line";
import { hasControlCharacters } from "@/lib/title";
import { isTitleHeading } from "@/lib/title-heading";
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
 * The guard starts when line 1 is the title line by the one rule
 * (isTitleHeading in lib/title-heading.ts: it says the title, is exactly
 * `# <title>`, or is an empty `# `), when the note is loaded, when its title
 * changes, and when the editor adds the line itself. From then on it holds
 * while line 1 keeps its `# `, which it always does, so a title being
 * retyped stays guarded before the rename it asks for lands.
 *
 * Only edits from this editor are checked: text loaded from outside (a
 * reload, someone else's save) is shown as it is. Undo and redo are checked
 * too: the title line an older note gets with its first edit is outside undo
 * history, so text undone back to the very top goes below it instead.
 * A note whose first line is not its title line (an older note not edited
 * since D-120, one that opens with a heading that says something else, or
 * one whose headings are linked or anchored and so never gets one) is not
 * guarded; it shows its title above the text instead (see TitlePreview),
 * writing nothing.
 */

/** A first line that is a title line: `#`, then a space or tab. Its first two characters are the prefix. */
const TITLE_LINE_RE = /^#[ \t]/;
const PREFIX = 2;

/** Marks the title line this editor adds to an older note with its first edit. */
export const titleLineChange = Annotation.define<boolean>();

/** Tells the editor the note's title, for the title line shown above a note that has none yet. */
export const setNoteTitle = StateEffect.define<string>();

/**
 * A rename from outside settled and no renamed text is coming (DOQ-46): a
 * line 1 that does not say the title is no longer the title line, so the
 * guard lets it go and the title shows above it (TitlePreview).
 */
export const releaseTitleLine = StateEffect.define<null>();

const titleField = StateField.define<string>({
  create: () => "",
  update(title, tr) {
    for (const effect of tr.effects) if (effect.is(setNoteTitle)) title = effect.value;
    return title;
  },
});

/** Whether line 1 still has the `# ` a title line keeps. */
function hasPrefix(doc: Text): boolean {
  return TITLE_LINE_RE.test(doc.line(1).text);
}

/**
 * Whether the guard holds (see above), and whether line 1 still says an
 * older title (`stale`).
 *
 * The guard is read afresh from the rule when the text is loaded, the title
 * changes or the editor adds the title line, and kept otherwise while line 1
 * has its `# `. One exception: a title changed from outside the editor (a
 * rename from the sidebar) while line 1 is the title line keeps the guard.
 * Line 1 is still the title line; it only says the old title until the
 * renamed text lands, and shows the new one meanwhile (see StaleTitle).
 * Without this, line 1 would stop being the title line for a moment, and the
 * new title would show above it as a second line.
 *
 * That lasts only while the renamed text is on its way. When the rename
 * settles without it (releaseTitleLine: the server left line 1 alone and the
 * workspace may not rewrite it, DOQ-46), a line 1 that does not say the
 * title stops being the title line.
 */
type Guard = { held: boolean; stale: boolean };

const guardField = StateField.define<Guard>({
  create: (state) => ({ held: isTitleHeading(state.doc.line(1).text, state.field(titleField)), stale: false }),
  update(guard, tr) {
    let title: string | null = null;
    let release = false;
    for (const effect of tr.effects) {
      if (effect.is(setNoteTitle)) title = effect.value;
      if (effect.is(releaseTitleLine)) release = true;
    }
    const loaded = tr.annotation(external) || tr.annotation(titleLineChange);
    const line = tr.newDoc.line(1).text;
    if (release && !loaded) {
      const held = guard.held && isTitleHeading(line, title ?? tr.state.field(titleField));
      return { held, stale: false };
    }
    if (title !== null && !loaded && !tr.docChanged && guard.held && hasPrefix(tr.newDoc)) {
      return { held: true, stale: !isTitleHeading(line, title) };
    }
    if (title !== null || loaded) {
      return { held: isTitleHeading(line, title ?? tr.startState.field(titleField)), stale: false };
    }
    if (!tr.docChanged) return guard;
    // Editing line 1 while it shows a newer title shows its real text again.
    const touched = tr.changes.touchesRange(0, tr.startState.doc.line(1).to);
    return { held: guard.held && hasPrefix(tr.newDoc), stale: guard.stale && !touched };
  },
});

/** Whether the guard holds for `state`: line 1 is the note's title line, being edited or not. */
export function guarded(state: EditorState): boolean {
  return state.field(guardField, false)?.held ?? false;
}

/**
 * The open editor's title line, for the workspace once a rename from
 * outside has settled (DOQ-46): whether the guard holds line 1, and letting
 * it go when no renamed text is coming (releaseTitleLine).
 */
export type TitleLineHandle = {
  held(): boolean;
  /** Line 1's text as the editor shows it now. */
  line(): string;
  /** Rewrites line 1 to `# <title>` when it still says `expected` (retitleLine); the text after, or null. */
  retitle(title: string, expected: string): string | null;
  release(): void;
};

/**
 * The handle for `view` (DOQ-46), until `close()`: the editor closes it when
 * its view goes (a remount, say, when the layout changes). A closed handle
 * holds nothing and changes nothing, so a settle still waiting on its safety
 * reads cannot rewrite a view no longer on screen: a destroyed EditorView
 * still takes a transaction, but nothing hears it.
 */
export function titleLineHandle(view: {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
}): TitleLineHandle & { close(): void } {
  let open = true;
  return {
    held: () => open && guarded(view.state),
    line: () => (open ? view.state.doc.line(1).text : ""),
    retitle(title, expected) {
      const spec = open ? retitleLine(view.state, title, expected) : null;
      if (!spec) return null;
      view.dispatch(spec);
      return view.state.doc.toString();
    },
    release() {
      if (open) view.dispatch({ effects: releaseTitleLine.of(null) });
    },
    close() {
      open = false;
    },
  };
}

/**
 * Line 1 rewritten to `# <title>` after a rename from outside that left it
 * saying something else (DOQ-46), or null when the editor cannot take it:
 * read-only, line 1 not held as the title line, or no longer saying
 * `expected` (typed on since). An edit of this editor like any other,
 * reported and saved, and its own step in undo history: undoing it puts back
 * exactly what line 1 said, and the guard keeps holding it. Not checked by
 * the guard (titleLineChange), which reads line 1 afresh from the rule.
 */
export function retitleLine(state: EditorState, title: string, expected: string): TransactionSpec | null {
  const name = title.trim();
  if (state.readOnly || !guarded(state) || !name || hasControlCharacters(name)) return null;
  const line = state.doc.line(1);
  const insert = `# ${name}`;
  if (line.text !== expected || line.text === insert) return null;
  return {
    changes: { from: 0, to: line.to, insert },
    annotations: [titleLineChange.of(true), isolateHistory.of("full")],
  };
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
 *
 * `mode` is "format" for toolbar commands, and "history" for undo and redo:
 * text they put back at the very top was there before the title line was
 * added (outside history) above it, so it goes, exactly as it was, to the
 * start of the body, where it was followed by what now follows the title.
 */
export function repairTitleLine(
  doc: Text,
  edits: readonly Edit[],
  mode: "edit" | "format" | "history" = "edit",
): { changes: ChangeSet; caret: number | null } | null {
  const format = mode === "format";
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
    } else if (mode === "history" && from === to && from < PREFIX) {
      // Undone or redone back to the very top: below the title line instead.
      const text = lines.join("\n");
      caret = (hasBody ? push(titleEnd + 1, titleEnd + 1, text) : push(titleEnd, titleEnd, `\n${text}`)) ?? caret;
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
 * A rewrite is the original transaction followed by the correction, in one:
 * every annotation it carries stays (undo and redo keep their place in the
 * history, a paste stays a paste), and its effects are mapped on through the
 * correction. A single caret goes where repairTitleLine says; several are
 * each mapped through the corrected changes, so none is lost.
 */
const guard = EditorState.transactionFilter.of((tr): Transaction | TransactionSpec | readonly TransactionSpec[] => {
  if (!tr.docChanged) return tr;
  if (tr.annotation(external) || tr.annotation(titleLineChange)) return tr;
  const start = tr.startState;
  if (start.readOnly || !guarded(start)) return tr;

  const edits: Edit[] = [];
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    edits.push({ from, to, lines: inserted.toJSON() });
  });
  const titleEnd = start.doc.line(1).to;
  const history = tr.isUserEvent("undo") || tr.isUserEvent("redo");
  if (!history) {
    if (LINE_MOVES.some((event) => tr.isUserEvent(event)) && edits.some((edit) => touchesTitle(edit, titleEnd))) {
      return {};
    }
    // Ctrl-T: swapping across the `# ` or the title's line break; inside the title it swaps as usual.
    if (tr.isUserEvent("move.character") && edits.some((edit) => crossesTitle(edit, titleEnd))) return {};
    if (tr.isUserEvent("input.format") && edits.some((edit) => touchesTitle(edit, titleEnd) && !insideTitleText(edit, titleEnd))) {
      return {};
    }
  }

  const mode = history ? "history" : tr.isUserEvent("input.format") ? "format" : "edit";
  const repaired = repairTitleLine(start.doc, edits, mode);
  if (!repaired) return hasPrefix(tr.newDoc) || history ? tr : {};
  if (!hasPrefix(repaired.changes.apply(start.doc))) return history ? tr : {};
  if (repaired.changes.empty && repaired.caret === null && !history) return {};

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
  // From the text the original made to the corrected one.
  const correction = tr.changes.invert(start.doc).compose(repaired.changes);
  // The original, as a spec: its annotations go with it into the merged transaction.
  return [tr as unknown as TransactionSpec, { changes: correction, selection, sequential: true }];
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
    if (state.readOnly || !guarded(state)) return false;
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
 * link list open, Enter is the list's. With several carets it is the default
 * Enter's: the guard then moves a break typed in the title to the body, and
 * keeps every caret.
 */
export function enterFromTitle(view: { state: EditorState; dispatch: (spec: TransactionSpec) => void }): boolean {
  const { state } = view;
  if (state.readOnly || !guarded(state)) return false;
  if (state.selection.ranges.length > 1) return false;
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

/** The note's new title, shown over line 1's text while that still says the old one. */
class StaleTitle extends WidgetType {
  constructor(readonly title: string) {
    super();
  }

  eq(other: StaleTitle) {
    return other.title === this.title;
  }

  toDOM() {
    const text = document.createElement("span");
    text.dataset.testid = "title-line-pending";
    text.textContent = this.title;
    return text;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * Line 1 is styled as the note's title. A note that does not open with its
 * title line (and is not guarded) shows the one it will get, above the text and outside it:
 * nothing is written for it until the note's first edit (and never, for a
 * note whose headings are linked or anchored).
 */
export function titleLineDecorations(state: EditorState): DecorationSet {
  const title = state.field(titleField);
  if (!guarded(state) && title.trim() && !hasTitleLine(state.doc.toString(), title)) {
    return Decoration.set([
      Decoration.widget({ widget: new TitlePreview(title.trim()), block: true, side: -1 }).range(0),
    ]);
  }
  if (!guarded(state)) return Decoration.none;
  const line = Decoration.line({ class: "cm-title-line" }).range(0);
  const first = state.doc.line(1);
  if (state.field(guardField).stale && title.trim() && first.to > PREFIX) {
    const shown = Decoration.replace({ widget: new StaleTitle(title.trim()) }).range(PREFIX, first.to);
    return Decoration.set([line, shown]);
  }
  return Decoration.set([line]);
}

const decorations = StateField.define<DecorationSet>({
  create: titleLineDecorations,
  update(value, tr) {
    const titleChanged = tr.effects.some((effect) => effect.is(setNoteTitle) || effect.is(releaseTitleLine));
    if (!tr.docChanged && !titleChanged) return value;
    return titleLineDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The title line, for an editor showing a note titled `title`. */
export function titleLine(title: string): Extension {
  return [
    titleField.init(() => title),
    guardField,
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
