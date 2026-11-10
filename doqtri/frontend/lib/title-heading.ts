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

  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline;
    // The `\r` of a CRLF ending stays where it is, outside the line.
    const lineEnd = end > start && markdown[end - 1] === "\r" ? end - 1 : end;
    const line = markdown.slice(start, lineEnd);

    if (!BLANK_RE.test(line)) {
      const match = H1_RE.exec(line);
      if (!match) return null;
      if (normalizeConcept(cleanLabel(match[1])) !== wanted) return null;

      const heading = titleHeading(newTitle);
      if (heading === line) return null;
      return markdown.slice(0, start) + heading + markdown.slice(lineEnd);
    }

    if (newline === -1) break;
    start = newline + 1;
  }
  return null;
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
