import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import {
  previewSpecs,
  revealedLines,
  tableBlocks,
  touches,
  type DocRange,
  type PreviewSpec,
} from "@/lib/live-preview/decorations";
import { previewParser } from "@/lib/live-preview/syntax";

/** Specs for `source` with the caret (or selections) at the given ranges. */
function render(source: string, selection: DocRange[] = []) {
  const doc = Text.of(source.split("\n"));
  const tree = previewParser.parse(source);
  const revealed = revealedLines(doc, selection, tableBlocks(tree, doc));
  return { doc, specs: previewSpecs(tree, doc, revealed) };
}

/** The text of every hidden range, in document order. */
function hidden(source: string, selection: DocRange[] = []): string[] {
  return render(source, selection)
    .specs.filter((spec): spec is Extract<PreviewSpec, { kind: "hide" }> => spec.kind === "hide")
    .sort((a, b) => a.from - b.from)
    .map((spec) => source.slice(spec.from, spec.to));
}

function widgets(source: string, selection: DocRange[] = []) {
  return render(source, selection).specs.filter(
    (spec): spec is Extract<PreviewSpec, { kind: "widget" }> => spec.kind === "widget",
  );
}

function classesAt(source: string, pos: number, selection: DocRange[] = []): string[] {
  return render(source, selection)
    .specs.filter((spec) => spec.kind === "mark" && spec.from <= pos && pos < spec.to)
    .map((spec) => (spec as { cls: string }).cls);
}

function lineClasses(source: string, selection: DocRange[] = []): string[] {
  return render(source, selection)
    .specs.filter((spec) => spec.kind === "line")
    .map((spec) => (spec as { cls: string }).cls);
}

const caret = (pos: number): DocRange => ({ from: pos, to: pos });

describe("headings", () => {
  const source = "intro\n## Goals\nbody";
  const headingLine = source.indexOf("## Goals");

  it("hides the hashes and the space after them when the caret is elsewhere", () => {
    expect(hidden(source, [caret(0)])).toEqual(["## "]);
  });

  it("shows the raw heading while the caret is on its line", () => {
    expect(hidden(source, [caret(headingLine + 5)])).toEqual([]);
    expect(hidden(source, [caret(headingLine)])).toEqual([]);
    // The end of the line is still on the line.
    expect(hidden(source, [caret(headingLine + "## Goals".length)])).toEqual([]);
  });

  it("sizes the line either way, so the caret moving never changes its height", () => {
    expect(lineClasses(source, [caret(0)])).toEqual(["cm-lp-h2"]);
    expect(lineClasses(source, [caret(headingLine + 3)])).toEqual(["cm-lp-h2"]);
  });

  it("hides optional closing hashes too", () => {
    expect(hidden("# Title ##\n\nx", [caret(12)])).toEqual(["# ", " ##"]);
  });

  it("renders everything when nothing is selected (unfocused or read-only)", () => {
    expect(hidden(source)).toEqual(["## "]);
  });
});

describe("inline syntax", () => {
  const source = "**bold** _it_ ~~gone~~ `code`\nnext";

  it("hides every mark on a line the caret is not on", () => {
    expect(hidden(source, [caret(source.length)])).toEqual(["**", "**", "_", "_", "~~", "~~", "`", "`"]);
  });

  it("keeps them on the caret's line, muted", () => {
    expect(hidden(source, [caret(3)])).toEqual([]);
    expect(classesAt(source, 0, [caret(3)])).toContain("cm-lp-syntax");
  });

  it("styles the content in both states", () => {
    for (const selection of [[caret(3)], [caret(source.length)]]) {
      expect(classesAt(source, 3, selection)).toContain("cm-lp-strong");
      expect(classesAt(source, source.indexOf("it"), selection)).toContain("cm-lp-em");
      expect(classesAt(source, source.indexOf("gone"), selection)).toContain("cm-lp-strike");
      expect(classesAt(source, source.indexOf("code"), selection)).toContain("cm-lp-code");
    }
  });

  it("hides a link's brackets and destination, keeping its text as a link", () => {
    const link = "see [the docs](https://example.com \"t\") now\nx";
    expect(hidden(link, [caret(link.length)])).toEqual(["[", '](https://example.com "t")']);
    expect(classesAt(link, link.indexOf("the docs"), [caret(link.length)])).toContain("cm-lp-link");
    expect(hidden(link, [caret(2)])).toEqual([]);
  });

  it("styles bare URLs and hides an autolink's angle brackets", () => {
    const text = "<https://a.example> and https://b.example\nx";
    expect(hidden(text, [caret(text.length)])).toEqual(["<", ">"]);
    expect(classesAt(text, text.indexOf("b.example"), [caret(text.length)])).toContain("cm-lp-link");
  });

  it("hides an escape's backslash", () => {
    expect(hidden("\\*not em\\*\nx", [caret(12)])).toEqual(["\\", "\\"]);
  });
});

describe("wikilinks", () => {
  it("hides the brackets and styles the title as a link", () => {
    const text = "see [[Other note]]\nx";
    expect(hidden(text, [caret(text.length)])).toEqual(["[[", "]]"]);
    expect(classesAt(text, text.indexOf("Other"), [caret(text.length)])).toContain("cm-lp-wikilink");
    expect(hidden(text, [caret(5)])).toEqual([]);
  });

  it("reads as its alias when it has one", () => {
    const text = "[[Target|shown]]\nx";
    expect(hidden(text, [caret(text.length)])).toEqual(["[[", "Target|", "]]"]);
  });

  it("leaves bracketed prose alone: no definitions, so no reference links", () => {
    expect(hidden("a [note] and [x][y]\nz", [caret(21)])).toEqual([]);
  });

  it("is not a wikilink with an empty target or a newline inside", () => {
    expect(hidden("[[ ]]\nx", [caret(7)])).toEqual([]);
    expect(hidden("[[a\nb]]", [caret(0)])).toEqual([]);
  });
});

describe("block syntax", () => {
  it("swaps a bullet for a dot and keeps ordered numbers", () => {
    const list = "- one\n1. two\n";
    expect(widgets(list, [caret(list.length)]).map((w) => w.widget)).toEqual([{ type: "bullet" }]);
    expect(widgets(list, [caret(1)])).toEqual([]);
    expect(classesAt(list, list.indexOf("1."), [caret(1)])).toContain("cm-lp-list-number");
  });

  it("draws task markers as checkboxes", () => {
    const tasks = "- [x] done\n- [ ] todo\n\nx";
    const drawn = widgets(tasks, [caret(tasks.length)]).filter((w) => w.widget.type === "task");
    expect(drawn.map((w) => w.widget)).toEqual([
      { type: "task", checked: true },
      { type: "task", checked: false },
    ]);
    // The checkbox replaces the bullet rather than sitting beside it.
    expect(hidden(tasks, [caret(tasks.length)])).toEqual(["- ", "- "]);
    expect(widgets(tasks, [caret(tasks.length)]).filter((w) => w.widget.type === "bullet")).toEqual([]);
  });

  it("hides a quote's marker and space, bordering every line of it", () => {
    const quote = "> one\n> two\n\nx";
    expect(hidden(quote, [caret(quote.length)])).toEqual(["> ", "> "]);
    expect(lineClasses(quote, [caret(quote.length)])).toEqual(["cm-lp-quote", "cm-lp-quote"]);
    // Only the caret's line shows its marker.
    expect(hidden(quote, [caret(2)])).toEqual(["> "]);
  });

  it("draws a horizontal rule unless the caret is on it", () => {
    const rule = "a\n\n---\n\nb";
    expect(widgets(rule, [caret(0)]).map((w) => w.widget)).toEqual([{ type: "hr" }]);
    expect(widgets(rule, [caret(4)])).toEqual([]);
  });

  it("styles a fenced block and hides its fences, line by line", () => {
    const code = "```ts\nconst a = 1;\n```\n\nx";
    const away = render(code, [caret(code.length)]);
    expect(away.specs.filter((s) => s.kind === "line").map((s) => (s as { cls: string }).cls)).toEqual([
      "cm-lp-fence cm-lp-fence-first",
      "cm-lp-fence",
      "cm-lp-fence cm-lp-fence-last",
    ]);
    expect(widgets(code, [caret(code.length)]).map((w) => w.widget)).toEqual([{ type: "fence", lang: "ts" }]);
    expect(hidden(code, [caret(code.length)])).toEqual(["```"]);
    // On the opening fence: that fence is raw, the closing one still hidden.
    expect(widgets(code, [caret(2)])).toEqual([]);
    expect(hidden(code, [caret(2)])).toEqual(["```"]);
  });

  it("never hides markup inside code", () => {
    const code = "```\n**not bold**\n```\n\nx";
    expect(hidden(code, [caret(code.length)])).toEqual(["```"]);
  });
});

describe("selections", () => {
  const source = "# One\n**two**\n## Three\nfour";

  it("reveals every line a multi-line selection touches", () => {
    const from = source.indexOf("two");
    const to = source.indexOf("Three") + 2;
    expect(hidden(source, [{ from, to }])).toEqual(["# "]);
  });

  it("reveals the lines of every selection range", () => {
    expect(hidden(source, [caret(1), caret(source.indexOf("Three"))])).toEqual(["**", "**"]);
  });

  it("marks lines for a selection anchored after its head the same way", () => {
    const doc = Text.of(source.split("\n"));
    expect([...revealedLines(doc, [{ from: 0, to: source.length }])]).toEqual([1, 2, 3, 4]);
  });
});

describe("tables", () => {
  const source = ["intro", "", "| a | **b** |", "| :- | -: |", "| 1 | 2 |", "", "outro"].join("\n");
  const doc = Text.of(source.split("\n"));
  const tree = previewParser.parse(source);
  const [table] = tableBlocks(tree, doc);

  it("finds the table's full lines", () => {
    expect(source.slice(table.from, table.to)).toBe("| a | **b** |\n| :- | -: |\n| 1 | 2 |");
  });

  it("reveals the whole table when the caret is on any one of its rows", () => {
    for (const line of [3, 4, 5]) {
      const pos = doc.line(line).from + 2;
      expect([...revealedLines(doc, [caret(pos)], [table])].sort()).toEqual([3, 4, 5]);
    }
  });

  it("reveals it for a selection that only reaches its edge", () => {
    expect(touches({ from: 0, to: table.from }, table)).toBe(true);
    expect(touches({ from: table.to, to: table.to + 2 }, table)).toBe(true);
    expect(touches(caret(0), table)).toBe(false);
  });

  it("leaves a drawn table to the grid: no inline decorations inside it", () => {
    const { specs } = render(source, [caret(0)]);
    expect(specs.filter((s) => "from" in s && s.from >= table.from && s.from <= table.to)).toEqual([]);
  });

  it("shows a revealed table as plain source, its formatting untouched", () => {
    const { specs } = render(source, [caret(table.from + 3)]);
    expect(specs.filter((s) => s.kind === "hide")).toEqual([]);
    expect(specs.filter((s) => s.kind === "line").map((s) => (s as { cls: string }).cls)).toEqual([
      "cm-lp-table-src",
      "cm-lp-table-src",
      "cm-lp-table-src",
    ]);
  });

  it("does not draw a table nested in a list", () => {
    const nested = "- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n";
    const nestedDoc = Text.of(nested.split("\n"));
    expect(tableBlocks(previewParser.parse(nested), nestedDoc)).toEqual([]);
  });
});

describe("images", () => {
  it("draws an https image when the caret is off its line", () => {
    const text = "![A cat](https://img.example/cat.png \"Cat\")\nx";
    expect(widgets(text, [caret(text.length)]).map((w) => w.widget)).toEqual([
      { type: "image", url: "https://img.example/cat.png", alt: "A cat", title: "Cat" },
    ]);
  });

  it("shows the source while the caret is on its line", () => {
    const text = "![A cat](https://img.example/cat.png)\nx";
    expect(widgets(text, [caret(3)])).toEqual([]);
    expect(classesAt(text, 3, [caret(3)])).toContain("cm-lp-image-src");
  });

  it("never draws an image from anything but http(s)", () => {
    for (const url of ["javascript:alert(1)", "data:image/png;base64,AAAA", "/api/secret.png", "file:///etc/x.png"]) {
      const text = `![x](${url})\nx`;
      expect(widgets(text, [caret(text.length)]), url).toEqual([]);
    }
  });
});

describe("syntax broken over lines", () => {
  /** Valid CommonMark/GFM whose syntax spans a line break. */
  const SAMPLES = [
    '[a](/uri\n"title")',
    "![alt\ntext](https://x.com/a.png)",
    '![a](https://x.com/a.png\n"t")',
    "-\n  [ ] task",
    "[two\nlines](https://x.com)",
    "**bold\nover lines** and _it\nalic_",
    "> quote\nlazy line",
    "```js\ncode\n```",
    "# Heading #\n\n- [x]\n\n1.\n   next",
  ];

  it("never hides or replaces a line break, whatever the caret", () => {
    for (const source of SAMPLES) {
      const text = `${source}\n\nend`;
      for (const selection of [[], [caret(text.length)], [caret(0)]]) {
        for (const spec of render(text, selection).specs) {
          if (spec.kind !== "hide" && spec.kind !== "widget") continue;
          expect(text.slice(spec.from, spec.to), JSON.stringify(source)).not.toContain("\n");
        }
      }
    }
  });

  it("shows a link with its title on the next line as source", () => {
    const text = '[a](/uri\n"title")\n\nend';
    expect(hidden(text, [caret(text.length)])).toEqual([]);
    expect(classesAt(text, 1, [caret(text.length)])).toContain("cm-lp-link");
  });

  it("does not draw an image whose alt text or title runs onto the next line", () => {
    for (const source of ["![alt\ntext](https://x.com/a.png)", '![a](https://x.com/a.png\n"t")']) {
      const text = `${source}\n\nend`;
      expect(widgets(text, [caret(text.length)]), source).toEqual([]);
      expect(classesAt(text, 2, [caret(text.length)])).toContain("cm-lp-image-src");
    }
  });

  it("hides only the bullet of a task that starts on the next line", () => {
    const text = "-\n  [ ] task\n\nend";
    expect(hidden(text, [caret(text.length)])).toEqual(["-"]);
    expect(widgets(text, [caret(text.length)]).map((w) => w.widget)).toEqual([{ type: "task", checked: false }]);
  });
});
