/**
 * Tidies markdown produced by the DOCX/PPTX extractor before it is sent to the
 * model. The extractor emits two artifacts that are noise here: an empty YAML
 * frontmatter block, and Pandoc-style `{#slug}` anchors on every heading. Left
 * in, the model tends to echo them into the note.
 */
export function cleanExtractedMarkdown(markdown: string): string {
  return (
    markdown
      // Leading frontmatter block, only when it has no keys in it.
      .replace(/^[ \t]*---[ \t]*\n[ \t]*---[ \t]*\n/, "")
      /*
       * Heading anchors: `## Ingestion {#ingestion}` -> `## Ingestion`.
       * Horizontal whitespace only — `\s*$` under the `m` flag would consume
       * the newlines after the heading and collapse the blank line with it.
       */
      .replace(/^(#{1,6}[ \t]+.*?)[ \t]*\{#[^}]*\}[ \t]*$/gm, "$1")
      .trim()
  );
}
