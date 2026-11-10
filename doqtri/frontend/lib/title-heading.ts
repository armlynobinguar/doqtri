import { cleanLabel } from "@/lib/mindmap";
import { normalizeConcept } from "@/lib/mindmap-types";
import { hasControlCharacters } from "@/lib/title";

/** A level-1 ATX heading, read the way lib/mindmap.ts reads headings. */
const H1_RE = /^#[ \t]+(.*)$/;
/**
 * A blank line: spaces, tabs, form feeds and vertical tabs only. The same
 * class as title_heading_rewrite() in 20261109100000_rename_document.sql, so
 * both pick the same first non-blank line.
 */
const BLANK_RE = /^[ \t\f\v]*$/;

/**
 * The note's text after a rename from `oldTitle` to `newTitle` (DOQ-35), or
 * null when the rename leaves the text alone.
 *
 * A note usually opens with `# <title>`, and the mindmap folds that heading
 * into its root only while it matches the title (DOQ-30). So when the first
 * non-blank line is a level-1 heading whose text is the old title, that line
 * becomes `# <newTitle>`. The text is read as the mindmap reads a heading
 * (cleanLabel: `[[Target]]` as Target, `[[Target|Alias]]` as Alias, closing
 * `#`s dropped) and compared as titles are, ignoring case and spacing. So
 * `# [[Old]]` is the title heading of "Old", and `# [[Old|Alias]]` is that
 * of "Alias", as deriveTitle() and the fold see them. The whole line is
 * replaced by a plain `# <newTitle>`: a wikilink there is not kept. Every
 * other byte stays, the line's own ending (`\r\n` or `\n`) included.
 *
 * Any other first line (another heading, a `##`, prose, or the title
 * heading further down) is the user's own, and null is returned. So is a new
 * title that is not one line, which the routes refuse anyway: written into
 * the heading, a line break would add headings and move the ones after it.
 */
export function rewriteTitleHeading(
  markdown: string,
  oldTitle: string,
  newTitle: string,
): string | null {
  const wanted = normalizeConcept(oldTitle);
  if (!wanted || hasControlCharacters(newTitle)) return null;

  const line = firstNonBlankLine(markdown);
  if (!line) return null;
  const label = headingLabel(line.text);
  if (label === null || normalizeConcept(label) !== wanted) return null;

  const heading = titleHeading(newTitle);
  if (heading === line.text) return null;
  return markdown.slice(0, line.from) + heading + markdown.slice(line.to);
}

/**
 * The note's first non-blank line: its text, without the line ending, and
 * where that text starts and ends in `markdown`. The `\r` of a CRLF ending is
 * outside the line. Null when every line is blank.
 */
export function firstNonBlankLine(markdown: string): { text: string; from: number; to: number } | null {
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline;
    const lineEnd = end > start && markdown[end - 1] === "\r" ? end - 1 : end;
    const text = markdown.slice(start, lineEnd);
    if (!BLANK_RE.test(text)) return { text, from: start, to: lineEnd };
    if (newline === -1) break;
    start = newline + 1;
  }
  return null;
}

/**
 * What a level-1 heading line says, read as the mindmap reads a heading
 * (cleanLabel), or null when `line` is not one. `# [[Target|Alias]]` reads
 * as Alias.
 */
export function headingLabel(line: string): string | null {
  const match = H1_RE.exec(line);
  return match ? cleanLabel(match[1]) : null;
}

/**
 * `# <title>`, exactly what rename_document() accepts in place of the old
 * heading. A title ending in ` #` reads back without that tail (as a
 * closing sequence); that is left as it is rather than written differently
 * from what the database checks.
 */
function titleHeading(title: string): string {
  return `# ${title.trim()}`;
}
