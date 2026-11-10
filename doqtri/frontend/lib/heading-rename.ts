import { normalizeConcept } from "@/lib/mindmap-types";
import { hasControlCharacters, MAX_TITLE_LENGTH } from "@/lib/title";
import { firstNonBlankLine, headingLabel } from "@/lib/title-heading";

/**
 * Renaming a note from its title heading (DOQ-36), the other way round from
 * lib/title-heading.ts: there a rename rewrites the heading, here an edit of
 * the heading renames the note, so the two stay one thing and the mindmap
 * keeps folding the heading into its root (DOQ-30).
 *
 * The title heading is the note's first non-blank line when that line is a
 * level-1 ATX heading, read the way rewriteTitleHeading() and the mindmap
 * read it (`# [[Target|Alias]]` says Alias). Since D-120 that line is the
 * note's title line (lib/title-line.ts): the editor keeps it first and keeps
 * its `# `, and a note that opened with something else gets one above it
 * with its first edit. So whatever it says is the title, and a change to it
 * renames, whether or not it said the title before.
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

/** Whether `markdown` opens with a heading that says `title`. */
export function opensWithTitle(markdown: string, title: string): boolean {
  const first = readFirstLine(markdown);
  return first.kind === "heading" && normalizeConcept(first.label) === normalizeConcept(title);
}

export type NoRenameReason =
  /**
   * The heading says the title, or still says what it said before the edit:
   * nothing about the title line changed. A heading that differs from the
   * title without having been edited (a rename made elsewhere won, or the
   * note was loaded that way) is left until someone edits it.
   */
  | "unchanged"
  /** The heading was emptied, or the note is blank: nothing to rename to yet. */
  | "emptied"
  /** The first line is not a `#` heading (a `##`, prose): only text the editor did not guard. */
  | "not-heading"
  /** The new heading would be refused as a title: control characters, or too long. */
  | "invalid-title";

export type HeadingRenameDecision =
  | { rename: true; title: string }
  | { rename: false; reason: NoRenameReason };

/**
 * Whether an edit from `before` to `after` renames a note titled `title`,
 * and to what. A rename needs all of:
 *   - `after` opens with a level-1 heading saying something other than the
 *     title, compared as titles are; a change of case or spacing alone keeps
 *     the fold, and is not a rename
 *   - that heading changed with the edit: `before` did not open with a
 *     heading saying the same, so a heading nobody touched (one loaded from
 *     outside, or one a refused rename left behind) never renames by itself
 *   - its text is a title the server takes: one line, at most
 *     MAX_TITLE_LENGTH characters
 * The new title is the heading's text, trimmed, as the server would store it.
 *
 * What `before` opened with does not matter otherwise (D-120): the first
 * line is the title line, so editing it renames even when it never said the
 * title, say in a note whose title line was added above an older heading.
 * Editing it into text that some later heading also has renames too: the
 * note then has two headings saying its title, which is the student's to
 * tidy up.
 */
export function decideHeadingRename(before: string, after: string, title: string): HeadingRenameDecision {
  const first = readFirstLine(after);
  if (first.kind === "blank" || first.kind === "empty-heading") return { rename: false, reason: "emptied" };
  if (first.kind === "other") return { rename: false, reason: "not-heading" };

  const next = first.label.trim();
  if (normalizeConcept(next) === normalizeConcept(title)) return { rename: false, reason: "unchanged" };
  const previous = readFirstLine(before);
  if (previous.kind === "heading" && normalizeConcept(previous.label) === normalizeConcept(next)) {
    return { rename: false, reason: "unchanged" };
  }
  if (hasControlCharacters(next) || next.length > MAX_TITLE_LENGTH) {
    return { rename: false, reason: "invalid-title" };
  }
  return { rename: true, title: next };
}

/**
 * Whether, after a decision that renames nothing, `after` becomes the text
 * the next edit is compared with.
 *
 * A heading emptied or not yet a valid title is a heading being retyped: the
 * comparison stays with the text from before, so typing a new heading once it
 * is gone still renames. Anything definite moves it on: the heading saying
 * the title or what it said before, or a first line that is not a `#`
 * heading at all (text the editor's title line guard did not see, such as a
 * read-only copy's).
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
