/**
 * GFM tables, read from their source lines for the rendered grid.
 *
 * The parse tree says where a table starts and ends; the cells are split here
 * instead, because the tree leaves out empty cells and the grid needs every
 * column. Splitting follows the GFM spec: cells are separated by unescaped
 * pipes, the outer pipes are optional, and every body row is padded or cut to
 * the header's column count.
 */

export type TableAlign = "left" | "center" | "right" | null;

export type TableCell = {
  /** The cell's source, trimmed. */
  text: string;
  /** Document range of `text`; an empty cell is a zero-length range. */
  from: number;
  to: number;
};

export type ParsedTable = {
  align: TableAlign[];
  header: TableCell[];
  rows: TableCell[][];
};

export type SourceLine = { text: string; from: number };

const PIPE = "|";

/** Splits one row into its cells, with document offsets. */
export function splitRow(line: SourceLine): TableCell[] {
  const { text, from } = line;
  const bounds: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++; // an escaped character, pipes included, belongs to the cell
      continue;
    }
    if (text[i] === PIPE) bounds.push(i);
  }

  let start = 0;
  let end = text.length;
  // Outer pipes are optional; only whitespace may stand outside them.
  const leading = text.search(/\S/);
  if (bounds.length > 0 && bounds[0] === leading) {
    start = bounds.shift()! + 1;
  }
  const trailing = text.trimEnd().length - 1;
  if (bounds.length > 0 && bounds[bounds.length - 1] === trailing) {
    end = bounds.pop()!;
  }

  const cells: TableCell[] = [];
  let cellStart = start;
  for (const bound of [...bounds, end]) {
    const raw = text.slice(cellStart, bound);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    const cellFrom = from + cellStart + lead;
    cells.push({ text: trimmed, from: cellFrom, to: cellFrom + trimmed.length });
    cellStart = bound + 1;
  }
  return cells;
}

/** Column alignment from the delimiter row's colons. */
export function parseAlignments(line: SourceLine): TableAlign[] {
  return splitRow(line).map(({ text }) => {
    const left = text.startsWith(":");
    const right = text.endsWith(":") && text.length > 1;
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/**
 * The table in `lines`: header, delimiter row, then body rows. Returns null
 * for anything that is not a table (fewer than two lines, or a header whose
 * column count does not match the delimiter row's, as GFM requires).
 */
export function parseTable(lines: SourceLine[]): ParsedTable | null {
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const align = parseAlignments(lines[1]);
  if (header.length === 0 || header.length !== align.length) return null;

  const columns = header.length;
  const rows = lines.slice(2).map((line) => {
    const cells = splitRow(line).slice(0, columns);
    // A short row is padded with empty cells at its end.
    const end = line.from + line.text.length;
    while (cells.length < columns) cells.push({ text: "", from: end, to: end });
    return cells;
  });
  return { align, header, rows };
}
