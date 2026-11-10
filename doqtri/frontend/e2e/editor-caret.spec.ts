import { test, expect, type Page } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  expectEditorText,
  noteEditor,
  placeCaretAfter,
  seedNote,
  setEditorSelection,
  uniqueTitle,
} from "./helpers";

/*
 * The editor shows rendered markdown everywhere but the caret's line, which
 * shows its source. Two things must hold for that to feel like typing in one
 * document: keys land at the caret, in the markdown, character for
 * character; and moving the caret onto a line or off it changes only which
 * syntax characters show — never how tall the line is, so the text below
 * does not jump.
 */

const RICH = [
  "# Heading one",
  "",
  "## Overview",
  "",
  "Write like Obsidian. Headings become the mindmap. Link ideas with [[wikilinks]]. **Bold words**, _italic words_, ~~struck~~ and `inline code` keep the same line height as plain text.",
  "",
  "### A list",
  "",
  "- first item with a [link](https://example.com/some/really/long/path/that/keeps/going)",
  "- second item",
  "  - nested item",
  "1. ordered",
  "- [ ] task",
  "",
  "> a quote that is long enough to wrap onto a second visual line in the narrow editor column, and then some more",
  "",
  "---",
  "",
  "```ts",
  "const x = { a: 1, b: [2, 3] }; // a code block",
  "```",
  "",
  "averyveryveryveryveryveryveryveryveryveryveryveryveryveryveryveryverylongunbrokenwordthatmustbreak",
  "",
  "Unicode: café, naïve, — dashes — and “quotes”.",
  "",
  "## Next",
  "",
].join("\n");

/**
 * Short lines, one of each kind of syntax: none wraps, raw or rendered, so a
 * line's height can only change if the preview itself changes it.
 */
const SHORT = [
  "# Heading one",
  "",
  "## Overview",
  "",
  "Some **bold** and _it_",
  "`code` and ~~gone~~",
  "A [link](https://x.io)",
  "See [[wiki]] here",
  "",
  "- item",
  "1. ordered",
  "- [ ] task",
  "",
  "> quote",
  "",
  "---",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "#### Small",
  "end",
].join("\n");

/** Every line's height, top to bottom, as laid out right now. */
function lineHeights(page: Page): Promise<number[]> {
  return noteEditor(page).evaluate((content) =>
    [...content.querySelectorAll<HTMLElement>(".cm-line")].map((line) => Math.round(line.getBoundingClientRect().height)),
  );
}

test.describe("editor caret", () => {
  let noteId: string;

  test.afterEach(async () => {
    if (noteId) await deleteNote(noteId);
  });

  test("typed letters land where the caret is", async ({ page }) => {
    noteId = await seedNote(
      uniqueTitle("Caret"),
      "# Untitled 3\n\n## Overview\n\nWrite like Obsidian. Headings become the mindmap. Link ideas with [[wikilinks]].\n\n## Next\n",
    );
    await page.goto(`/vault/${noteId}`);
    await editableEditor(page);

    // The exact sequence from the old bug report: append to the long line,
    // break, then type an indented word.
    await placeCaretAfter(page, "[[wikilinks]].");
    await page.keyboard.type("ddddd");
    await page.keyboard.press("Enter");
    await page.keyboard.type(" edit");
    await expectEditorText(page, /\[\[wikilinks\]\]\.ddddd\n edit\n\n## Next/);
  });

  test("typing inside styled text edits the markdown at the caret", async ({ page }) => {
    noteId = await seedNote(uniqueTitle("Caret Rich"), RICH);
    await page.goto(`/vault/${noteId}`);
    await editableEditor(page);

    await placeCaretAfter(page, "**Bo");
    await page.keyboard.type(" more bold text that forces a rewrap");
    await expectEditorText(page, /\*\*Bo more bold text that forces a rewrapld words\*\*/);
  });

  test("moving the caret between lines never changes a line's height", async ({ page }) => {
    noteId = await seedNote(uniqueTitle("Caret Heights"), SHORT);
    await page.goto(`/vault/${noteId}`);
    await editableEditor(page);
    await page.evaluate(() => document.fonts.ready);

    // Caret on the last line: everything above is rendered.
    await setEditorSelection(page, -1);
    const rendered = await lineHeights(page);

    // Each line in turn shows its source; no line grows or shrinks for it.
    const text = SHORT.split("\n");
    let offset = 0;
    for (const [index, line] of text.entries()) {
      // Images and tables are widgets with heights of their own; SHORT has none.
      if (line.length > 0) {
        await setEditorSelection(page, offset + Math.min(2, line.length));
        await expect.poll(() => lineHeights(page), { message: `line ${index + 1}: ${line}` }).toEqual(rendered);
      }
      offset += line.length + 1;
    }

  });
});
