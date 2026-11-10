import { hasControlCharacters } from "@/lib/title";
import { firstNonBlankLine, headingLabel } from "@/lib/title-heading";

/**
 * The note's title line (D-120): like Obsidian, the first line of every note
 * is `# <title>`, the title itself rather than removable content. Editing its
 * text renames the note (DOQ-36, lib/heading-rename.ts), a rename from the
 * explorer rewrites it (DOQ-35, lib/title-heading.ts), and the editor keeps
 * its `# ` in place (components/vault/live-editor/title-line.ts).
 *
 * New notes, templates and market copies already start with it. A note that
 * does not (written before D-120, pasted in through the API, renamed from the
 * explorer while its first line was prose) gets one with its first real edit,
 * saved with that edit; opening a note writes nothing. `# <title>` goes above
 * whatever the note opens with, which moves down untouched, and the note is
 * never renamed after its own first line. Notes whose headings are linked or
 * anchored never get one (lib/title-line-safety.ts): every heading's
 * positional id would move down by one.
 *
 * Whatever level-1 heading a note already opens with is its title line, even
 * when it says something other than the title: a heading the student typed,
 * one a refused rename left behind (another note had that title), or one a
 * Regenerate wrote. It is kept, and editing it renames as usual; nothing is
 * pushed under it.
 */

/** One change to the note's text, in its positions. */
export type TextChange = { from: number; to: number; insert: string };

/** Whether `text`, a whole line, is a title line: a level-1 heading with text, or exactly `# <title>`. */
function isTitleLine(text: string, name: string): boolean {
  if (name && text === `# ${name}`) return true;
  const label = headingLabel(text);
  return label !== null && label.length > 0;
}

/**
 * The change that gives the note its title line, or null when it already has
 * one (or `title` is not one a note can have, which the routes refuse anyway).
 *
 *   - It opens with a title line after blank lines: the blank lines go, so
 *     the title is the first line, not just the first non-blank one.
 *   - Its first non-blank line is an empty heading (`#`, `# `): that becomes
 *     `# <title>`, as there is nothing in it to keep.
 *   - Anything else (prose, a `##`, a list, nothing at all): `# <title>` and
 *     a blank line go above it, with the blank lines it opened with folded
 *     into that one. An empty note becomes just `# <title>`.
 *
 * The title line is checked by its raw text as well as the way the mindmap
 * reads it, so a title such as `Week #` or `C# ##`, which reads differently
 * once its closing `#`s are dropped, is still its own title line. The note's
 * own line ending is used, `\r\n` when it has any.
 */
export function titleLineEdit(markdown: string, title: string): TextChange | null {
  const name = title.trim();
  if (!name || hasControlCharacters(name)) return null;

  const first = firstNonBlankLine(markdown);
  const heading = `# ${name}`;
  if (!first) return { from: 0, to: markdown.length, insert: heading };
  if (isTitleLine(first.text, name)) return first.from === 0 ? null : { from: 0, to: first.from, insert: "" };
  if (/^#[ \t]*$/.test(first.text) || headingLabel(first.text) === "") {
    return { from: 0, to: first.to, insert: heading };
  }
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  return { from: 0, to: first.from, insert: heading + eol + eol };
}

/** The note's text with its title line in place, or null when it already has one (see titleLineEdit). */
export function withTitleLine(markdown: string, title: string): string | null {
  const change = titleLineEdit(markdown, title);
  if (!change) return null;
  const next = markdown.slice(0, change.from) + change.insert + markdown.slice(change.to);
  return next === markdown ? null : next;
}

/** Whether the note opens with its title line, after any blank lines: nothing would be put above it. */
export function hasTitleLine(markdown: string, title: string): boolean {
  const first = firstNonBlankLine(markdown);
  return first !== null && isTitleLine(first.text, title.trim());
}
