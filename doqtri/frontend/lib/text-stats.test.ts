import { describe, expect, it } from "vitest";
import { previewParser } from "@/lib/live-preview/syntax";
import { countWords, hiddenSyntax, renderedText, textCounts } from "@/lib/text-stats";

const rendered = (doc: string, from?: number, to?: number) =>
  renderedText(doc, hiddenSyntax(previewParser.parse(doc), doc), from, to);
const counts = (doc: string) => textCounts(rendered(doc));

describe("countWords", () => {
  it("counts words split by any whitespace", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("  one\ttwo\n\nthree ")).toBe(3);
  });
});

describe("rendered counts", () => {
  it("leave out heading, emphasis, list, quote and task marks", () => {
    expect(counts("# Title **bold**")).toEqual({ words: 2, chars: 10 });
    expect(rendered("- one\n1. two\n- [ ] three\n> four")).toBe("one\ntwo\nthree\nfour");
    expect(rendered("a *b* ~~c~~ `d` e\\*")).toBe("a b c d e*");
    expect(rendered("## Closed ##")).toBe("Closed");
  });

  it("keep link text and drop the address; read a wikilink as it renders", () => {
    expect(rendered('see [the docs](https://example.com "Docs") now')).toBe("see the docs now");
    expect(rendered("[[Target]] and [[Target|alias]]")).toBe("Target and alias");
  });

  it("count no image, rule or HTML", () => {
    expect(rendered("a ![alt text](https://x.example/p.png) b")).toBe("a  b");
    expect(counts("a\n\n---\n\nb<br>")).toEqual({ words: 2, chars: 2 });
  });

  it("read a table as its cells", () => {
    expect(rendered("| a | b |\n| - | - |\n| 1 | 2 |")).toBe("a b 1 2");
    expect(counts("| one | two |\n| --- | --- |")).toEqual({ words: 2, chars: 7 });
  });

  it("keep the code inside fences, not the fences", () => {
    expect(rendered("```js\nconst a = 1;\n```")).toBe("\nconst a = 1;\n");
    expect(counts("```js\nconst a = 1;\n```").words).toBe(4);
  });

  it("hide the syntax inside link text and table cells too", () => {
    expect(counts("[**bold** link](u)")).toEqual({ words: 2, chars: 9 });
    expect(counts("[![alt](img)](url)").words).toBe(0);
    expect(rendered("| **a** | [x](https://u.example/long/path) |\n| - | - |")).toBe("a x");
  });

  it("count a selection the same way", () => {
    const doc = "intro **bold words** and [a link](https://x.example)";
    expect(textCounts(rendered(doc, 6, 20))).toEqual({ words: 2, chars: 10 });
    expect(rendered(doc, 25, doc.length)).toBe("a link");
  });

  it("count a selection from the syntax around it alone, as the whole note does", () => {
    const doc = "# Head\n\n" + "word **bold** [link](https://x.example) ".repeat(200) + "\n\nend";
    const tree = previewParser.parse(doc);
    const from = 300;
    const to = 900;
    const local = renderedText(doc, hiddenSyntax(tree, doc, from, to), from, to);
    expect(local).toBe(renderedText(doc, hiddenSyntax(tree, doc), from, to));
  });
});
