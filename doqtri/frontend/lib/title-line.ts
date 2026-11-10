import { opensWithTitle } from "@/lib/heading-rename";
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
 * explorer while its first line was not the title heading) gets one the
 * first time it is opened where it can be edited: `# <title>` goes above
 * whatever it opens with, which moves down untouched. The note is never
 * renamed after its own first line. That is all this file decides; the
 * editor makes the change, and the ordinary debounced save stores it.
 */

/**
 * How strictly a note's opening is checked.
 *   open    the note as the page loaded it, with the title the page loaded
 *           with: it must open with the heading that says that title
 *   reload  text loaded from outside later (a reload, a regenerate), while
 *           the page's title may lag behind a rename made elsewhere: any
 *           level-1 heading with text counts as the title line, so a heading
 *           someone else just renamed the note from is never pushed down
 *           under the old title
 */
export type TitleLineCheck = "open" | "reload";

/**
 * The note's text with its title line in place, or null when it already has
 * one (or `title` is not one a note can have, which the routes refuse anyway).
 *
 *   - It opens with the title line after blank lines: the blank lines go, so
 *     the title is the first line, not just the first non-blank one.
 *   - Its first non-blank line is an empty heading (`#`, `# `): that becomes
 *     `# <title>`, as there is nothing in it to keep.
 *   - Anything else (prose, a `##`, a `#` heading saying something else, or
 *     nothing at all): `# <title>` and a blank line go above it, with the
 *     blank lines it opened with folded into that one. An empty note becomes
 *     just `# <title>`.
 *
 * The note's own line ending is used, `\r\n` when it has any.
 */
export function withTitleLine(markdown: string, title: string, check: TitleLineCheck): string | null {
  const name = title.trim();
  if (!name || hasControlCharacters(name)) return null;

  const first = firstNonBlankLine(markdown);
  const label = first ? headingLabel(first.text) : null;
  const isTitleLine = check === "open" ? opensWithTitle(markdown, name) : label !== null && label.length > 0;
  if (first && isTitleLine) return first.from === 0 ? null : markdown.slice(first.from);

  const heading = `# ${name}`;
  if (!first) return heading;
  if (/^#[ \t]*$/.test(first.text) || label === "") return heading + markdown.slice(first.to);
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  return heading + eol + eol + markdown.slice(first.from);
}
