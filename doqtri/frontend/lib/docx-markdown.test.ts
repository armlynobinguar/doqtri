import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docxToMarkdown, htmlToMarkdown } from "@/lib/docx-markdown";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(`e2e/fixtures/ingest/${name}`));

/** Unescaped `|` count, i.e. column boundaries on a pipe-table line. */
const pipes = (line: string) => (line.match(/(?<!\\)\|/g) ?? []).length;

const tableLines = (markdown: string) =>
  markdown.split("\n").filter((line) => line.startsWith("|"));

describe("htmlToMarkdown tables", () => {
  it("uses the first row as the header", () => {
    const md = htmlToMarkdown("<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(md).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("leaves the slots a rowspan covers empty", () => {
    const md = htmlToMarkdown(
      '<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>',
    );
    expect(md).toBe("| a | b |\n| --- | --- |\n|  | c |");
  });

  it("keeps columns aligned across a colspan", () => {
    const md = htmlToMarkdown(
      '<table><tr><td colspan="2">wide</td><td>x</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
    );
    expect(md).toBe("| wide |  | x |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
  });

  it("escapes pipes and joins paragraphs inside a cell", () => {
    const md = htmlToMarkdown("<table><tr><td><p>a | b</p><p>c</p></td></tr></table>");
    expect(md).toBe("| a \\| b<br>c |\n| --- |");
  });

  it("flattens a nested table into its cell", () => {
    const md = htmlToMarkdown(
      "<table><tr><td>outer</td><td><table><tr><td>x</td><td>y</td></tr></table></td></tr></table>",
    );
    expect(md).toBe("| outer | x, y |\n| --- | --- |");
  });

  it("drops images", () => {
    expect(htmlToMarkdown('<p>before<img src="data:image/png;base64,AAAA">after</p>')).toBe(
      "beforeafter",
    );
  });
});

describe("docxToMarkdown fixtures", () => {
  it("converts headings and a plain table", async () => {
    const md = await docxToMarkdown(fixture("docx-table-simple.docx"));
    expect(md).toContain("# Sprint Plan");
    expect(md).toContain("## Milestones");
    expect(md).toContain("| Milestone | Owner | Due |");
    expect(md).toContain("| Streaming ingest | Dev | Week 1 |");
  });

  it("keeps every row of a merged-cell table the same width", async () => {
    const lines = tableLines(await docxToMarkdown(fixture("docx-table-merged.docx")));
    expect(lines.length).toBe(5); // header, separator, three rows
    expect(new Set(lines.map(pipes))).toEqual(new Set([5]));
    expect(lines.join("\n")).not.toContain("<table");
  });

  it("flattens a nested table instead of emitting HTML", async () => {
    const md = await docxToMarkdown(fixture("docx-table-nested.docx"));
    expect(md).toContain("in00, in01; in10, in11");
    expect(md).not.toContain("<table");
  });

  it("converts a 400-row table quickly", async () => {
    const started = Date.now();
    const lines = tableLines(await docxToMarkdown(fixture("docx-table-large.docx")));
    expect(lines.length).toBe(401); // 400 rows plus the separator
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
