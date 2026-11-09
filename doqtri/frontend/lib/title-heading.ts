import { normalizeConcept } from "@/lib/mindmap-types";

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
 * non-blank line is a level-1 heading whose text is the old title — compared
 * as titles are, ignoring case and spacing, with any closing `#`s dropped —
 * that line becomes `# <newTitle>`. Every other byte is kept, the line's own
 * ending (`\r\n` or `\n`) included.
 *
 * Any other first line (another heading, a `##`, prose, or the title
 * heading further down) is the user's own, and null is returned.
 */
export function rewriteTitleHeading(
  markdown: string,
  oldTitle: string,
  newTitle: string,
): string | null {
  const wanted = normalizeConcept(oldTitle);
  if (!wanted) return null;

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
      const text = match[1].replace(CLOSING_HASHES_RE, "");
      if (normalizeConcept(text) !== wanted) return null;

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
