import { normalizeConcept } from "@/lib/mindmap-types";
import { hasControlCharacters, MAX_TITLE_LENGTH } from "@/lib/title";
import { firstNonBlankLine, headingLabel, isTitleHeading } from "@/lib/title-heading";

/**
 * Renaming a note from its title heading (DOQ-36), the other way round from
 * lib/title-heading.ts: there a rename rewrites the heading, here an edit of
 * the heading renames the note, so the two stay one thing and the mindmap
 * keeps folding the heading into its root (DOQ-30).
 *
 * The title heading is the note's first non-blank line when that line is its
 * title line (isTitleHeading, D-120: the rule the editor and the rename route
 * share): a level-1 heading that says the title, read the way the mindmap
 * reads it (`# [[Target|Alias]]` says Alias), or is exactly `# <title>`, or
 * is an empty `# `. A heading that never said the title is the student's
 * own, and is left alone; since D-120 the editor puts the title line above
 * it with the note's first edit.
 */

/** What the first non-blank line of a note is, for the rule below. */
export type FirstLine =
  /** Every line is blank: nothing there yet. */
  | { kind: "blank" }
  /** `#` or `# ` with nothing after it. */
  | { kind: "empty-heading" }
  /** A level-1 heading saying `label`. */
  | { kind: "heading"; label: string }
  /** Anything else: a `##`, prose, a list. */
  | { kind: "other" };

export function readFirstLine(markdown: string): FirstLine {
  const line = firstNonBlankLine(markdown);
  if (!line) return { kind: "blank" };
  const label = headingLabel(line.text);
  if (label === null) return /^#[ \t]*$/.test(line.text) ? { kind: "empty-heading" } : { kind: "other" };
  return label.length > 0 ? { kind: "heading", label } : { kind: "empty-heading" };
}

/** Whether `markdown` opens with its title line (isTitleHeading), after any blank lines. */
export function opensWithTitle(markdown: string, title: string): boolean {
  const line = firstNonBlankLine(markdown);
  return line !== null && isTitleHeading(line.text, title);
}

export type NoRenameReason =
  /** The heading still says the title. */
  | "unchanged"
  /** Before the edit the first line was not the title line (isTitleHeading): the student's own. */
  | "not-title-heading"
  /** The heading was deleted or emptied, or the note is blank: nothing to rename to yet. */
  | "emptied"
  /** The first line is no longer a `#` heading (a `##`, prose). */
  | "not-heading"
  /**
   * The title heading line was deleted or moved down, and a `#` heading that
   * was already further down is now first: that is another section, not a
   * new title.
   */
  | "heading-removed"
  /** The new heading would be refused as a title: control characters, or too long. */
  | "invalid-title";

export type HeadingRenameDecision =
  | { rename: true; title: string }
  | { rename: false; reason: NoRenameReason };

/**
 * Whether an edit from `before` to `after` renames a note titled `title`,
 * and to what. A rename needs all of:
 *   - `before` opened with the title line (isTitleHeading): it said `title`,
 *     or was exactly `# <title>`, or was an empty `# `
 *   - `after` opens with a level-1 heading saying something else, compared
 *     as titles are; a change of case or spacing alone keeps the fold, and
 *     is not a rename
 *   - that text is a title the server takes: one line, at most
 *     MAX_TITLE_LENGTH characters
 * The new title is the heading's text, trimmed, as the server would store it.
 *
 * The title heading's line must also still be the one that was edited.
 * Deleting it, or cutting it to paste it lower, brings up a `#` heading that
 * was already further down; renaming the note after that section would be
 * wrong, so it renames nothing (see movedUp). Editing the first line into
 * text that some later heading also has is still an edit of that line, and
 * renames: the note then has two headings saying its title, which is the
 * student's to tidy up.
 */
export function decideHeadingRename(before: string, after: string, title: string): HeadingRenameDecision {
  if (!opensWithTitle(before, title)) return { rename: false, reason: "not-title-heading" };

  const first = readFirstLine(after);
  if (first.kind === "blank" || first.kind === "empty-heading") return { rename: false, reason: "emptied" };
  if (first.kind === "other") return { rename: false, reason: "not-heading" };

  if (movedUp(before, after)) return { rename: false, reason: "heading-removed" };

  const next = first.label.trim();
  if (normalizeConcept(next) === normalizeConcept(title)) return { rename: false, reason: "unchanged" };
  if (hasControlCharacters(next) || next.length > MAX_TITLE_LENGTH) {
    return { rename: false, reason: "invalid-title" };
  }
  return { rename: true, title: next };
}

/** The note's lines, without their line endings. */
function lines(markdown: string): string[] {
  return markdown.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Whether the first non-blank line of `after` is a line that was already in
 * `before` below its first non-blank line, moved up rather than typed: it is
 * there no more often in `after` than it was further down in `before`. Line
 * identity is the whole line's text, so typing it anew (one more copy than
 * before) does not count as moved.
 */
function movedUp(before: string, after: string): boolean {
  const opening = firstNonBlankLine(after);
  const title = firstNonBlankLine(before);
  if (!opening || !title) return false;
  const later = lines(before.slice(title.to)).slice(1);
  const wasBelow = later.filter((line) => line === opening.text).length;
  if (wasBelow === 0) return false;
  return lines(after).filter((line) => line === opening.text).length <= wasBelow;
}

/**
 * Whether, after a decision that renames nothing, `after` becomes the text
 * the next edit is compared with.
 *
 * A heading emptied or not yet a valid title is a heading being retyped: the
 * comparison stays with the text from before, so typing a new heading once it
 * is gone still renames. Anything definite moves it on: the heading saying
 * the title, a heading that was never the title, a first line that is no
 * longer a `#` heading (the student made it something else), or a title
 * heading deleted or moved down. Then an edit of the heading now first,
 * another section's, cannot rename the note: the title heading is gone, and
 * one typed again that says the title links them again.
 */
export function movesBaseline(reason: NoRenameReason): boolean {
  return reason !== "emptied" && reason !== "invalid-title";
}

/**
 * The one notice shown at the title heading (DOQ-36):
 *   clash    the heading names a title another note has, so the note was
 *            not renamed; the text keeps the heading as typed
 *   renamed  the note was renamed from its heading, and `backlinks` other
 *            notes still link to the old title (their links are not rewritten)
 */
export type HeadingNotice =
  | { kind: "clash"; heading: string; title: string }
  | { kind: "renamed"; title: string; previousTitle: string; backlinks: number };

/** What the notice says: one sentence, and a hint after it. */
export function headingNoticeText(notice: HeadingNotice): { message: string; hint?: string } {
  if (notice.kind === "clash") {
    return {
      message: `Another note is already called “${notice.heading}”. The title stays “${notice.title}”.`,
      hint: "Edit the heading, or rename the note from the explorer.",
    };
  }
  const links = notice.backlinks === 1 ? "1 note still links" : `${notice.backlinks} notes still link`;
  return { message: `Renamed to “${notice.title}”. ${links} to “${notice.previousTitle}”.` };
}
