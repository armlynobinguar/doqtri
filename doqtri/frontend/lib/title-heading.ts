import { cleanLabel } from "@/lib/mindmap";
import { normalizeConcept } from "@/lib/mindmap-types";
import { hasControlCharacters } from "@/lib/title";

/** A level-1 ATX heading, read the way lib/mindmap.ts reads headings. */
const H1_RE = /^#[ \t]+(.*)$/;
/** A closing run of `#`s, which is not part of the heading's text. */
const CLOSING_HASHES_RE = /\s+#+\s*$/;

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

    if (line.trim() !== "") {
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
 * `# <title>`. A title that itself ends in ` #` gets a closing `#`, so the
 * heading still reads back as the whole title rather than losing its tail.
 */
function titleHeading(title: string): string {
  const text = title.trim();
  return CLOSING_HASHES_RE.test(text) ? `# ${text} #` : `# ${text}`;
}
