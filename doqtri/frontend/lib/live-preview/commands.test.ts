import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  insertLink,
  toggleBold,
  toggleBulletList,
  toggleCode,
  toggleHeading,
  toggleItalic,
  type FormatCommand,
} from "@/lib/live-preview/commands";

/** `|` marks the caret, `[` `]` a selection. Returns the result in the same notation. */
function run(command: FormatCommand, marked: string): string {
  const anchor = marked.includes("[") ? marked.indexOf("[") : marked.indexOf("|");
  const head = marked.includes("[") ? marked.indexOf("]") - 1 : anchor;
  const doc = marked.replace(/[|[\]]/g, "");
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  const next = state.update(command(state)).state;
  const { from, to } = next.selection.main;
  const text = next.doc.toString();
  return from === to
    ? `${text.slice(0, from)}|${text.slice(from)}`
    : `${text.slice(0, from)}[${text.slice(from, to)}]${text.slice(to)}`;
}

describe("toggleWrap", () => {
  it("wraps a selection, and unwraps it again", () => {
    expect(run(toggleBold, "a [word] b")).toBe("a **[word]** b");
    expect(run(toggleBold, "a **[word]** b")).toBe("a [word] b");
    expect(run(toggleBold, "a [**word**] b")).toBe("a [word] b");
  });

  it("opens an empty pair at the caret, and closes it again", () => {
    expect(run(toggleItalic, "a | b")).toBe("a *|* b");
    expect(run(toggleItalic, "a *|* b")).toBe("a | b");
  });

  it("italicises with asterisks, which work inside a word", () => {
    expect(run(toggleItalic, "un[believ]able")).toBe("un*[believ]*able");
    expect(run(toggleItalic, "un*[believ]*able")).toBe("un[believ]able");
  });

  it("tells bold and italic apart by the run of asterisks", () => {
    // Italic on bold adds a third asterisk rather than unwrapping the bold.
    expect(run(toggleItalic, "**[word]**")).toBe("***[word]***");
    expect(run(toggleItalic, "[**word**]")).toBe("*[**word**]*");
    expect(run(toggleBold, "*[word]*")).toBe("***[word]***");
    // Bold and italic together: either one comes off on its own.
    expect(run(toggleBold, "***[word]***")).toBe("*[word]*");
    expect(run(toggleItalic, "***[word]***")).toBe("**[word]**");
  });
});

describe("toggleCode", () => {
  it("wraps one line in backticks and several in a fence", () => {
    expect(run(toggleCode, "use [npm] here")).toBe("use `[npm]` here");
    expect(run(toggleCode, "[a\nb]")).toBe("```\n[a\nb]\n```");
  });
});

describe("line prefixes", () => {
  it("toggles a section heading", () => {
    expect(run(toggleHeading, "Go|als")).toBe("## Go|als");
    expect(run(toggleHeading, "## Go|als")).toBe("Go|als");
    expect(run(toggleHeading, "### Go|als")).toBe("Go|als");
  });

  it("toggles a bullet on every selected line, skipping blank ones", () => {
    expect(run(toggleBulletList, "[one\n\ntwo]")).toBe("- [one\n\n- two]");
    expect(run(toggleBulletList, "[- one\n- two]")).toBe("[one\ntwo]");
  });
});

describe("insertLink", () => {
  it("selects the URL to fill in for selected text", () => {
    expect(run(insertLink, "see [docs] now")).toBe("see [docs]([url]) now");
  });

  it("puts the caret in the text for a selected URL or nothing selected", () => {
    expect(run(insertLink, "[https://x.example]")).toBe("[|](https://x.example)");
    expect(run(insertLink, "a |")).toBe("a [|](url)");
  });
});
