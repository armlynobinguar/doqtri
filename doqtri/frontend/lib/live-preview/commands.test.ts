import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  clearFormatting,
  formatState,
  indentList,
  insertHorizontalRule,
  insertImage,
  insertLink,
  insertTable,
  insertWikilink,
  outdentList,
  setParagraphStyle,
  tableMarkdown,
  toggleBlockquote,
  toggleBold,
  toggleBulletList,
  toggleCode,
  toggleCodeBlock,
  toggleHeading,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleTaskList,
  type FormatCommand,
} from "@/lib/live-preview/commands";
import { previewParser } from "@/lib/live-preview/syntax";
import { parseTable } from "@/lib/live-preview/table";

/** `|` marks the caret, `[` `]` a selection. */
function stateOf(marked: string): EditorState {
  const anchor = marked.includes("[") ? marked.indexOf("[") : marked.indexOf("|");
  const head = marked.includes("[") ? marked.indexOf("]") - 1 : anchor;
  const doc = marked.replace(/[|[\]]/g, "");
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
}

/** Runs `command` on marked text; returns the result in the same notation. */
function run(command: FormatCommand, marked: string): string {
  const state = stateOf(marked);
  const next = state.update(command(state)).state;
  const { from, to } = next.selection.main;
  const text = next.doc.toString();
  return from === to
    ? `${text.slice(0, from)}|${text.slice(from)}`
    : `${text.slice(0, from)}[${text.slice(from, to)}]${text.slice(to)}`;
}

/** Like `run`, for documents whose text holds the notation's own characters. */
function runOn(command: FormatCommand, doc: string, anchor: number, head = anchor) {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  const next = state.update(command(state)).state;
  return { text: next.doc.toString(), selected: next.sliceDoc(next.selection.main.from, next.selection.main.to), state: next };
}

describe("bold and italic", () => {
  it("wraps a selection, and unwraps it again", () => {
    expect(run(toggleBold, "a [word] b")).toBe("a **[word]** b");
    expect(run(toggleBold, "a **[word]** b")).toBe("a [word] b");
    expect(run(toggleBold, "a [**word**] b")).toBe("a [word] b");
  });

  it("wraps the word under a bare caret, as Word does, and takes it off again", () => {
    expect(run(toggleBold, "a wo|rd b")).toBe("a **wo|rd** b");
    expect(run(toggleBold, "a **wo|rd** b")).toBe("a wo|rd b");
    expect(run(toggleItalic, "a wo|rd b")).toBe("a *wo|rd* b");
    expect(run(toggleItalic, "a *wo|rd* b")).toBe("a wo|rd b");
  });

  it("opens an empty pair at a caret outside any word, and closes it again", () => {
    expect(run(toggleItalic, "a | b")).toBe("a *|* b");
    expect(run(toggleItalic, "a *|* b")).toBe("a | b");
    expect(run(toggleBold, "word|")).toBe("word**|**");
    expect(run(toggleBold, "word**|**")).toBe("word|");
  });

  it("italicises with asterisks, which work inside a word", () => {
    expect(run(toggleItalic, "un[believ]able")).toBe("un*[believ]*able");
    expect(run(toggleItalic, "un*[believ]*able")).toBe("un[believ]able");
  });

  it("tells bold and italic apart", () => {
    // Italic on bold adds a third asterisk rather than unwrapping the bold.
    expect(run(toggleItalic, "**[word]**")).toBe("***[word]***");
    expect(run(toggleItalic, "[**word**]")).toBe("*[**word**]*");
    expect(run(toggleBold, "*[word]*")).toBe("***[word]***");
    // Bold and italic together: either one comes off on its own.
    expect(run(toggleBold, "***[word]***")).toBe("*[word]*");
    expect(run(toggleItalic, "***[word]***")).toBe("**[word]**");
    // The same with a bare caret.
    expect(run(toggleItalic, "**wo|rd**")).toBe("***wo|rd***");
    expect(run(toggleBold, "***wo|rd***")).toBe("*wo|rd*");
  });

  it("leaves block syntax and outer spaces out of the wrapped text", () => {
    expect(run(toggleBold, "[- item ]")).toBe("- **[item]** ");
    expect(run(toggleBold, "[## Title]")).toBe("## **[Title]**");
    expect(run(toggleItalic, "[one\n\ntwo]")).toBe("*[one*\n\n*two]*");
    expect(run(toggleItalic, "[*one*\n*two*]")).toBe("[one\ntwo]");
  });
});

describe("strikethrough", () => {
  it("toggles on a selection and on the word at a bare caret", () => {
    expect(run(toggleStrikethrough, "a [gone] b")).toBe("a ~~[gone]~~ b");
    expect(run(toggleStrikethrough, "a ~~[gone]~~ b")).toBe("a [gone] b");
    expect(run(toggleStrikethrough, "go|ne")).toBe("~~go|ne~~");
    expect(run(toggleStrikethrough, "~~go|ne~~")).toBe("go|ne");
  });
});

describe("inline code", () => {
  it("wraps one line in backticks and several in a fence", () => {
    expect(run(toggleCode, "use [npm] here")).toBe("use `[npm]` here");
    expect(run(toggleCode, "use `[npm]` here")).toBe("use [npm] here");
    expect(run(toggleCode, "[a\nb]")).toBe("```\n[a\nb]\n```");
  });

  it("wraps the word at a bare caret, and unwraps from inside", () => {
    expect(run(toggleCode, "use n|pm here")).toBe("use `n|pm` here");
    expect(run(toggleCode, "use `n|pm` here")).toBe("use n|pm here");
  });
});

describe("paragraph styles", () => {
  it("sets a heading level, replacing any other", () => {
    expect(run(setParagraphStyle("h1"), "Go|als")).toBe("# Go|als");
    expect(run(setParagraphStyle("h3"), "# Go|als")).toBe("### Go|als");
    expect(run(setParagraphStyle("h6"), "[Goals]")).toBe("###### [Goals]");
    // The style it already has: nothing changes.
    expect(run(setParagraphStyle("h2"), "## Go|als")).toBe("## Go|als");
  });

  it("turns headings, quotes and code back into Normal text", () => {
    expect(run(setParagraphStyle("normal"), "## Go|als")).toBe("Go|als");
    expect(run(setParagraphStyle("normal"), "> quo|ted")).toBe("quo|ted");
    expect(run(setParagraphStyle("normal"), "```\nco|de\n```")).toBe("co|de");
    expect(run(setParagraphStyle("normal"), "Ti|tle\n===")).toBe("Ti|tle");
    // The whole quote comes off, so no line of it stays quoted lazily.
    expect(run(setParagraphStyle("normal"), "> one\n> tw|o")).toBe("one\ntw|o");
  });

  it("quotes every selected line, blank ones too so the quote stays one block", () => {
    expect(run(setParagraphStyle("quote"), "[## one\n\ntwo]")).toBe("[> one\n>\n> two]");
    expect(run(setParagraphStyle("quote"), "te|xt")).toBe("> te|xt");
  });

  it("fences lines as a code block, empty or not", () => {
    expect(run(setParagraphStyle("codeblock"), "|")).toBe("```\n|\n```");
    expect(run(setParagraphStyle("codeblock"), "[## a\nb]")).toBe("```\n[a\nb]\n```");
    expect(run(setParagraphStyle("codeblock"), "```\nco|de\n```")).toBe("```\nco|de\n```");
  });

  it("keeps a list item's marker under a heading", () => {
    expect(run(setParagraphStyle("h2"), "- it|em")).toBe("- ## it|em");
    expect(run(setParagraphStyle("normal"), "- ## it|em")).toBe("- it|em");
  });

  it("toggles a section heading", () => {
    expect(run(toggleHeading, "Go|als")).toBe("## Go|als");
    expect(run(toggleHeading, "## Go|als")).toBe("Go|als");
    expect(run(toggleHeading, "### Go|als")).toBe("Go|als");
  });
});

describe("blockquote and code block buttons", () => {
  it("toggles a quote on, and off for the whole quote", () => {
    expect(run(toggleBlockquote, "wo|rd")).toBe("> wo|rd");
    expect(run(toggleBlockquote, "> wo|rd")).toBe("wo|rd");
    expect(run(toggleBlockquote, "[a\nb]")).toBe("> [a\n> b]");
    expect(run(toggleBlockquote, "> a\n> b|\n\nc")).toBe("a\nb|\n\nc");
  });

  it("toggles fences on and off", () => {
    expect(run(toggleCodeBlock, "co|de")).toBe("```\nco|de\n```");
    expect(run(toggleCodeBlock, "```js\nco|de\n```")).toBe("co|de");
    expect(run(toggleCodeBlock, "[a\nb]")).toBe("```\n[a\nb]\n```");
  });
});

describe("lists", () => {
  it("toggles a bullet on every selected line, skipping blank ones", () => {
    expect(run(toggleBulletList, "[one\n\ntwo]")).toBe("- [one\n\n- two]");
    expect(run(toggleBulletList, "[- one\n- two]")).toBe("[one\ntwo]");
    expect(run(toggleBulletList, "o|ne")).toBe("- o|ne");
    expect(run(toggleBulletList, "- o|ne")).toBe("o|ne");
  });

  it("numbers lines, continuing the list above", () => {
    expect(run(toggleOrderedList, "[a\nb]")).toBe("1. [a\n2. b]");
    expect(run(toggleOrderedList, "1. a\nb|")).toBe("1. a\n2. b|");
    expect(run(toggleOrderedList, "1. a|")).toBe("a|");
  });

  it("makes a checklist, and turns one list kind into another", () => {
    expect(run(toggleTaskList, "to|do")).toBe("- [ ] to|do");
    expect(runOn(toggleTaskList, "- [x] done", 8).text).toBe("done");
    expect(run(toggleTaskList, "- it|em")).toBe("- [ ] it|em");
    expect(run(toggleBulletList, "1. it|em")).toBe("- it|em");
    expect(runOn(toggleOrderedList, "- [ ] item", 8).text).toBe("1. item");
  });

  it("indents an item under the one above, and outdents it back", () => {
    expect(run(indentList, "- a\n- b|")).toBe("- a\n  - b|");
    expect(run(outdentList, "- a\n  - b|")).toBe("- a\n- b|");
    expect(run(indentList, "1. a\n2. b|")).toBe("1. a\n   1. b|");
    expect(run(outdentList, "1. a\n   1. b|")).toBe("1. a\n2. b|");
    expect(runOn(indentList, "- a\n- b\n- c", 4, 11).text).toBe("- a\n  - b\n  - c");
  });

  it("leaves lines that are not list items where they are", () => {
    expect(run(indentList, "pla|in")).toBe("pla|in");
    expect(run(outdentList, "- top|")).toBe("- top|");
  });
});

describe("links, wikilinks and images", () => {
  it("selects the URL to fill in for selected text or the word at a caret", () => {
    expect(runOn(insertLink, "see docs now", 4, 8)).toMatchObject({ text: "see [docs](url) now", selected: "url" });
    expect(runOn(insertLink, "see docs now", 6)).toMatchObject({ text: "see [docs](url) now", selected: "url" });
  });

  it("puts the caret in the text for a selected URL or nothing selected", () => {
    expect(runOn(insertLink, "https://x.example", 0, 17).text).toBe("[](https://x.example)");
    expect(runOn(insertLink, "a ", 2).text).toBe("a [](url)");
  });

  it("selects an existing link's URL to change it", () => {
    expect(runOn(insertLink, "[docs](https://a.example)", 2)).toMatchObject({
      text: "[docs](https://a.example)",
      selected: "https://a.example",
    });
  });

  it("wraps a wikilink around the selection or the word, caret before the brackets", () => {
    const empty = runOn(insertWikilink, "a ", 2);
    expect(empty.text).toBe("a [[]]");
    expect(empty.state.selection.main.head).toBe(4);
    const selected = runOn(insertWikilink, "see Other note now", 4, 14);
    expect(selected.text).toBe("see [[Other note]] now");
    expect(selected.state.selection.main.head).toBe(16);
    expect(runOn(insertWikilink, "see Note now", 6).text).toBe("see [[Note]] now");
  });

  it("inserts an image only for an http(s) address", () => {
    expect(runOn(insertImage("https://img.example/cat.png", "A cat"), "a ", 2).text).toBe(
      "a ![A cat](https://img.example/cat.png)",
    );
    expect(runOn(insertImage("https://img.example/a (1).png", "x [y]"), "old", 0, 3).text).toBe(
      "![x \\[y\\]](<https://img.example/a%20(1).png>)",
    );
    for (const url of ["javascript:alert(1)", "/relative.png", "data:image/png;base64,AAAA", "ftp://x.example/a.png"]) {
      expect(runOn(insertImage(url, "x"), "a ", 2).text).toBe("a ");
    }
  });
});

describe("blocks", () => {
  it("puts a horizontal line on its own block, never under text", () => {
    expect(run(insertHorizontalRule, "text|")).toBe("text\n\n---\n|");
    expect(run(insertHorizontalRule, "a\n|\nb")).toBe("a\n\n---\n|\nb");
    expect(run(insertHorizontalRule, "te|xt\nmore")).toBe("text\n\n---\n|\nmore");
  });

  it("writes a GFM table of the chosen size with a header row", () => {
    expect(tableMarkdown(2, 3)).toBe(
      ["| Column 1 | Column 2 |", "| -------- | -------- |", "|          |          |", "|          |          |"].join(
        "\n",
      ),
    );
    // Clamped to 1–8 either way.
    expect(tableMarkdown(20, 0).split("\n")).toHaveLength(2);
    expect(tableMarkdown(20, 0).split("\n")[0].match(/Column/g)).toHaveLength(8);
  });

  it("inserts a table that parses as one, the first header selected", () => {
    const { text, selected } = runOn(insertTable(3, 2), "Intro", 5);
    expect(text).toBe(`Intro\n\n${tableMarkdown(3, 2)}\n`);
    expect(selected).toBe("Column 1");
    let tables = 0;
    previewParser.parse(text).iterate({ enter: (node) => void (node.name === "Table" && tables++) });
    expect(tables).toBe(1);
    const lines = text.split("\n").slice(2, 5).map((line) => ({ text: line, from: 0 }));
    expect(parseTable(lines)?.header.map((cell) => cell.text)).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(parseTable(lines)?.rows).toHaveLength(1);
  });
});

describe("clearFormatting", () => {
  it("strips inline syntax from a selection and resets its lines to Normal", () => {
    const doc = "## **Bold** *it* ~~x~~ `c` [l](https://a.example) [[W]]";
    expect(runOn(clearFormatting, doc, 0, doc.length).text).toBe("Bold it x c l [[W]]");
    expect(runOn(clearFormatting, "> ***both***", 0, 12).text).toBe("both");
  });

  it("with a bare caret, clears the formatting around it and the line's style", () => {
    expect(run(clearFormatting, "# a **bo|ld** b")).toBe("a bo|ld b");
    expect(run(clearFormatting, "plain te|xt")).toBe("plain te|xt");
  });
});

describe("formatState", () => {
  const at = (marked: string) => formatState(stateOf(marked));

  it("presses the inline formats the caret or selection is inside", () => {
    expect(at("**bo|ld**")).toMatchObject({ bold: true, italic: false });
    expect(at("*it|*")).toMatchObject({ italic: true, bold: false });
    expect(at("***bo|th***")).toMatchObject({ bold: true, italic: true });
    expect(at("~~go|ne~~")).toMatchObject({ strike: true });
    expect(at("`co|de`")).toMatchObject({ code: true });
    expect(formatState(runOn(() => ({}), "[link](https://a.example)", 2).state)).toMatchObject({ link: true });
    // At either edge: outside.
    expect(at("|**bold**")).toMatchObject({ bold: false });
    expect(at("**bold**|")).toMatchObject({ bold: false });
    expect(at("**[bold]**")).toMatchObject({ bold: true });
    expect(at("[**bold** plain]")).toMatchObject({ bold: false });
  });

  it("presses the list kind and quote of the caret's line", () => {
    expect(at("- it|em")).toMatchObject({ bullet: true, ordered: false, task: false });
    expect(at("1. it|em")).toMatchObject({ ordered: true, bullet: false });
    expect(formatState(runOn(() => ({}), "- [ ] item", 8).state)).toMatchObject({ task: true, bullet: false });
    expect(at("> quo|te")).toMatchObject({ quote: true, style: "quote" });
    expect(at("pla|in")).toMatchObject({ bullet: false, quote: false, style: "normal" });
  });

  it("names the line's paragraph style", () => {
    expect(at("# Ti|tle").style).toBe("h1");
    expect(at("#### Ti|tle").style).toBe("h4");
    expect(at("Ti|tle\n---").style).toBe("h2");
    expect(at("```\nco|de\n```")).toMatchObject({ style: "codeblock", codeBlock: true });
    expect(at("> ## Ti|tle").style).toBe("h2");
  });
});
