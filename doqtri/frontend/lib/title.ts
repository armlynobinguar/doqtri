/** Strips a trailing file extension. */
function stripExtension(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, "");
}

/**
 * The title is what the graph resolves [[links]] against, so it matters that
 * it reads like something a person would link to. The document's own first
 * `#` heading is the best candidate; the filename is the fallback.
 */
export function deriveTitle(markdown: string, filename: string): string {
  for (const line of markdown.split("\n")) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (match) {
      const heading = match[1]
        // A heading that is itself a wikilink should not keep its brackets.
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) =>
          alias ?? target,
        )
        .trim();
      if (heading.length > 0) return heading;
    }
  }

  const fromFilename = stripExtension(filename).trim();
  return fromFilename.length > 0 ? fromFilename : "Untitled";
}

/**
 * Titles are the graph's join key, so duplicates would make [[links]]
 * ambiguous. Appends a counter until the title is unique within `taken`.
 * Comparison matches buildGraph: case- and trim-insensitive.
 */
export function uniqueTitle(title: string, taken: string[]): string {
  const normalize = (value: string) => value.trim().toLowerCase();
  const used = new Set(taken.map(normalize));
  if (!used.has(normalize(title))) return title;

  let counter = 2;
  while (used.has(normalize(`${title} ${counter}`))) counter += 1;
  return `${title} ${counter}`;
}
