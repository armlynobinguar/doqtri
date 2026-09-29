import mammoth from "mammoth";
import TurndownService from "turndown";
import { strikethrough } from "turndown-plugin-gfm";

/**
 * DOCX -> markdown via mammoth (DOCX -> semantic HTML) and turndown.
 *
 * Replaces officeparser for DOCX. officeparser emitted raw `<table>` HTML for
 * any table with merged or nested cells, plus a metadata frontmatter block, and
 * the model then had to re-type all of it. Here every table becomes a GFM pipe
 * table, which lib/ingest/tables.ts can lift out before the model call.
 *
 * turndown-plugin-gfm's own table rule is not used: it only converts tables
 * whose first row is `<th>`, and mammoth marks no header row unless the author
 * did, so most real tables would have been kept as HTML.
 */
export async function docxToMarkdown(bytes: Uint8Array): Promise<string> {
  const { value: html } = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    {
      // Never base64-encode embedded images: they are dropped below anyway,
      // and a few screenshots would otherwise dwarf the text.
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
    },
  );
  return htmlToMarkdown(html);
}

export function htmlToMarkdown(html: string): string {
  return blockService()
    .turndown(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function baseService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
  });
  service.use(strikethrough);
  // A rule, not `remove()`: the built-in image rule outranks removals.
  service.addRule("dropImages", { filter: "img", replacement: () => "" });
  service.remove(["script", "style"]);
  return service;
}

/** Top-level conversion: tables become GFM pipe tables. */
function blockService(): TurndownService {
  const service = baseService();
  const cells = cellService();
  service.addRule("gfmTable", {
    filter: "table",
    replacement: (_content, node) =>
      `\n\n${tableToGfm(node as HTMLElement, (cell) => cellText(cells, cell))}\n\n`,
  });
  return service;
}

/**
 * Converts one cell's content. A pipe table cell is a single line, so a table
 * nested inside a cell is flattened to `a, b; c, d` rather than rendered.
 */
function cellService(): TurndownService {
  const service = baseService();
  service.addRule("nestedTable", {
    filter: "table",
    replacement: (_content, node) =>
      ` ${tableRows(node as HTMLElement)
        .map((row) => cellsOf(row).map((c) => collapse(c.textContent ?? "")).join(", "))
        .join("; ")} `,
  });
  return service;
}

function cellText(service: TurndownService, cell: HTMLElement): string {
  return service
    .turndown(cell)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("<br>")
    .replace(/\|/g, "\\|");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isElement(node: Node, ...names: string[]): node is HTMLElement {
  return node.nodeType === 1 && names.includes(node.nodeName);
}

/** The table's own rows — never rows of a table nested in one of its cells. */
function tableRows(table: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const child of Array.from(table.childNodes)) {
    if (isElement(child, "TR")) rows.push(child);
    else if (isElement(child, "THEAD", "TBODY", "TFOOT")) {
      for (const row of Array.from(child.childNodes)) {
        if (isElement(row, "TR")) rows.push(row);
      }
    }
  }
  return rows;
}

function cellsOf(row: HTMLElement): HTMLElement[] {
  return Array.from(row.childNodes).filter((node): node is HTMLElement =>
    isElement(node, "TD", "TH"),
  );
}

function span(cell: HTMLElement, attribute: string, max: number): number {
  const value = Number.parseInt(cell.getAttribute(attribute) ?? "1", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 1), max) : 1;
}

/**
 * Lays a table out on a rectangular grid, then prints it as GFM. Merged cells
 * keep their text in the first slot and leave the slots they covered empty, so
 * every column still lines up. The first row is the header, as GFM requires.
 */
export function tableToGfm(
  table: HTMLElement,
  textOf: (cell: HTMLElement) => string,
): string {
  const grid: string[][] = [];
  // Rows still owed to a cell above that spans down into this column.
  const carried: number[] = [];

  for (const row of tableRows(table)) {
    const out: string[] = [];
    let col = 0;
    const skipCarried = () => {
      while ((carried[col] ?? 0) > 0) {
        carried[col] -= 1;
        out.push("");
        col += 1;
      }
    };

    for (const cell of cellsOf(row)) {
      skipCarried();
      const colspan = span(cell, "colspan", 64);
      const rowspan = span(cell, "rowspan", 1000);
      for (let i = 0; i < colspan; i += 1) {
        out.push(i === 0 ? textOf(cell) : "");
        if (rowspan > 1) carried[col] = rowspan - 1;
        col += 1;
      }
    }
    // Spans from above that reach past this row's last cell.
    while (col < carried.length) {
      skipCarried();
      if (col < carried.length) {
        out.push("");
        col += 1;
      }
    }
    grid.push(out);
  }

  const width = Math.max(0, ...grid.map((row) => row.length));
  if (grid.length === 0 || width === 0) return "";

  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;

  return [
    line(grid[0]),
    `|${" --- |".repeat(width)}`,
    ...grid.slice(1).map(line),
  ].join("\n");
}
