import { hasControlCharacters } from "@/lib/title";
import { firstNonBlankLine, isTitleHeading } from "@/lib/title-heading";

/**
 * The note's title line (D-120): like Obsidian, the first line of every note
 * is `# <title>`, the title itself rather than removable content. Editing its
 * text renames the note (DOQ-36, lib/heading-rename.ts), a rename from the
 * explorer rewrites it (DOQ-35, lib/title-heading.ts), and the editor keeps
 * its `# ` in place (components/vault/live-editor/title-line.ts). What counts
 * as the title line is one rule, isTitleHeading() in lib/title-heading.ts.
 *
 * New notes, templates and market copies already start with it. A note that
 * does not (written before D-120, pasted in through the API, or one whose
 * first line is a heading that says something else, such as `# Introduction`
 * or one a refused rename left behind) shows its title above the text until
 * its first edit, and gets `# <title>` then, above whatever it opens with,
 * which stays as it is. Opening a note writes nothing. Notes whose headings
 * are linked or anchored never get the line (lib/title-line-safety.ts):
 * every heading's positional id would move down by one.
 */

/** One change to the note's text, in its positions. */
export type TextChange = { from: number; to: number; insert: string };

/** Whether the note opens with its title line (isTitleHeading), after any blank lines. */
export function hasTitleLine(markdown: string, title: string): boolean {
  const first = firstNonBlankLine(markdown);
  return first !== null && isTitleHeading(first.text, title);
}

/**
 * The change that gives the note its title line, or null when it already has
 * one (or `title` is not one a note can have, which the routes refuse anyway).
 *
 * Always a plain insert at the very start that ends in a line break: the
 * text after it, blank lines included, stays exactly as it was, so an edit
 * made in it, or undone in it, lands where it was. A blank line goes between
 * the title and text that starts right away; text that already starts with a
 * blank line keeps it as that one. The note's own line ending is used,
 * `\r\n` when it has any.
 */
export function titleLineEdit(markdown: string, title: string): TextChange | null {
  const name = title.trim();
  if (!name || hasControlCharacters(name) || hasTitleLine(markdown, name)) return null;
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const spaced = markdown === "" || markdown.startsWith("\n") || markdown.startsWith("\r\n");
  return { from: 0, to: 0, insert: `# ${name}${eol}${spaced ? "" : eol}` };
}

/** The note's text with its title line in place, or null when it already has one (see titleLineEdit). */
export function withTitleLine(markdown: string, title: string): string | null {
  const change = titleLineEdit(markdown, title);
  return change ? change.insert + markdown : null;
}
