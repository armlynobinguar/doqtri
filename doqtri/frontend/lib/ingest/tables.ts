/**
 * Lifts tables out of extracted markdown before the AI formatting pass and puts
 * them back afterwards.
 *
 * Tables were the ingest hang: the model re-types every row, so a long table
 * turns into minutes of output and the request outlives the function. The model
 * has nothing to add to a table anyway, so it sees a one-line placeholder and
 * the original table is restored verbatim.
 */

const PLACEHOLDER = (n: number) => `{{TABLE_${n}}}`;
const PLACEHOLDER_PATTERN = /\{\{\s*TABLE_(\d+)\s*\}\}/g;
const SEPARATOR = /^\|(\s*:?-{3,}:?\s*\|)+\s*$/;

export const TABLE_PLACEHOLDER_INSTRUCTION =
  "Lines like {{TABLE_1}} stand in for tables that are inserted afterwards: " +
  "keep each one exactly as written, on its own line, where it belongs.";

export type LiftedTables = { text: string; tables: string[] };

/** Replaces GFM pipe tables and raw `<table>` blocks with placeholders. */
export function liftTables(markdown: string): LiftedTables {
  const tables: string[] = [];
  const out: string[] = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    // GFM: a `|` row immediately followed by a `| --- |` separator row.
    if (line.trimStart().startsWith("|") && SEPARATOR.test(lines[i + 1]?.trim() ?? "")) {
      let end = i + 2;
      while (end < lines.length && lines[end].trimStart().startsWith("|")) end += 1;
      tables.push(lines.slice(i, end).join("\n"));
      out.push(PLACEHOLDER(tables.length));
      i = end;
      continue;
    }

    // Raw HTML tables, which extractors emit for merged cells. Nested tables
    // are counted so the block ends at the outermost `</table>`.
    if (/^\s*<table[\s>]/i.test(line)) {
      let depth = 0;
      let end = i;
      for (; end < lines.length; end += 1) {
        depth += (lines[end].match(/<table[\s>]/gi) ?? []).length;
        depth -= (lines[end].match(/<\/table>/gi) ?? []).length;
        if (depth <= 0) break;
      }
      end = Math.min(end + 1, lines.length);
      tables.push(lines.slice(i, end).join("\n"));
      out.push(PLACEHOLDER(tables.length));
      i = end;
      continue;
    }

    out.push(line);
    i += 1;
  }

  return { text: out.join("\n"), tables };
}

/**
 * Puts each table back where the model left its placeholder. A table whose
 * placeholder the model dropped is appended at the end rather than lost, and a
 * placeholder it repeated is only filled once.
 */
export function restoreTables(markdown: string, tables: string[]): string {
  if (tables.length === 0) return markdown;
  const used = new Set<number>();

  let restored = markdown.replace(PLACEHOLDER_PATTERN, (_match, raw: string) => {
    const index = Number(raw) - 1;
    const table = tables[index];
    if (table === undefined || used.has(index)) return "";
    used.add(index);
    return `\n${table}\n`;
  });

  const missing = tables.filter((_, index) => !used.has(index));
  if (missing.length > 0) {
    restored = `${restored.trimEnd()}\n\n${missing.join("\n\n")}`;
  }
  return restored.replace(/\n{3,}/g, "\n\n").trim();
}
