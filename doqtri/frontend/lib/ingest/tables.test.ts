import { describe, expect, it } from "vitest";
import { liftTables, restoreTables } from "@/lib/ingest/tables";

const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";

describe("liftTables", () => {
  it("replaces a pipe table with a placeholder", () => {
    const { text, tables } = liftTables(`# Title\n\n${TABLE}\n\nAfter`);
    expect(text).toBe("# Title\n\n{{TABLE_1}}\n\nAfter");
    expect(tables).toEqual([TABLE]);
  });

  it("accepts the extractor's padded separator", () => {
    const padded = "| a | b |\n|  ---  |  ---  |\n| 1 | 2 |";
    expect(liftTables(padded).tables).toEqual([padded]);
  });

  it("leaves a lone pipe line that is not a table", () => {
    const input = "| not a table\nprose";
    expect(liftTables(input)).toEqual({ text: input, tables: [] });
  });

  it("lifts a raw HTML table through its outermost close tag", () => {
    const html = "<table>\n<tr><td><table><tr><td>x</td></tr></table></td></tr>\n</table>";
    const { text, tables } = liftTables(`before\n${html}\nafter`);
    expect(text).toBe("before\n{{TABLE_1}}\nafter");
    expect(tables).toEqual([html]);
  });
});

describe("restoreTables", () => {
  it("round-trips through lift and restore", () => {
    const input = `# Title\n\n${TABLE}\n\nAfter`;
    const { text, tables } = liftTables(input);
    expect(restoreTables(text, tables)).toBe(input);
  });

  it("tolerates whitespace the model adds inside the braces", () => {
    expect(restoreTables("x\n\n{{ TABLE_1 }}\n\ny", [TABLE])).toBe(`x\n\n${TABLE}\n\ny`);
  });

  it("appends a table whose placeholder the model dropped", () => {
    expect(restoreTables("# Title\n\nProse only.", [TABLE])).toBe(`# Title\n\nProse only.\n\n${TABLE}`);
  });

  it("fills a repeated placeholder only once", () => {
    const out = restoreTables("{{TABLE_1}}\n\nmiddle\n\n{{TABLE_1}}", [TABLE]);
    expect(out.split(TABLE).length - 1).toBe(1);
  });

  it("is a no-op without tables", () => {
    expect(restoreTables("{{TABLE_1}} stays", [])).toBe("{{TABLE_1}} stays");
  });
});
