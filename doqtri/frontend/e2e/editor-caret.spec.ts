import { test, expect, type Page } from "@playwright/test";
import { deleteNote, seedNote, uniqueTitle } from "./helpers";

/*
 * The markdown editor is a transparent <textarea> (it owns the caret and the
 * selection) stacked over a highlighted <pre> (it owns the glyphs you see). If
 * the two lay text out differently, typed letters appear somewhere other than
 * the caret. These tests pin that the two layers stay glyph-for-glyph aligned.
 */

const TEXTAREA = "textarea.w-md-editor-text-input";

const RICH = [
  "# Heading one",
  "",
  "## Overview",
  "",
  "Write like Obsidian. Headings become the mindmap. Link ideas with [[wikilinks]]. **Bold words**, _italic words_, ~~struck~~ and `inline code` must all keep the same width as plain text.",
  "",
  "### A list",
  "",
  "- first item with a [link](https://example.com/some/really/long/path/that/keeps/going)",
  "- second item",
  "  - nested\titem with a tab",
  "1. ordered",
  "- [ ] task",
  "",
  "> a quote that is long enough to wrap onto a second visual line in the narrow editor column",
  "",
  "```ts",
  "const x = { a: 1, b: [2, 3] }; // a code block",
  "```",
  "",
  "| col a | col b |",
  "| ----- | ----- |",
  "| 1     | 2     |",
  "",
  "averyveryveryveryveryveryveryveryveryveryveryveryveryveryveryveryverylongunbrokenwordthatmustbreak",
  "",
  "Unicode: café, naïve, — dashes — and “quotes”.",
  "",
  "## Next",
  "",
].join("\n");

type Report = {
  valueLength: number;
  preMatchesValue: boolean;
  styleDiffs: string[];
  worst: number;
  offenders: string[];
};

/**
 * Measures, for every visible character, where the textarea would draw it
 * (via an off-screen mirror carrying the textarea's computed style) versus
 * where the <pre> actually draws it. Returns the worst offset in pixels.
 */
async function measure(page: Page): Promise<Report> {
  return page.evaluate((selector) => {
    const ta = document.querySelector<HTMLTextAreaElement>(selector)!;
    const pre = document.querySelector<HTMLElement>(".w-md-editor-text-pre")!;
    const code = pre.querySelector<HTMLElement>("code")!;

    const props = [
      "font-family",
      "font-size",
      "line-height",
      "font-weight",
      "font-style",
      "letter-spacing",
      "word-spacing",
      "font-variant-ligatures",
      "font-feature-settings",
      "font-kerning",
      "tab-size",
      "white-space",
      "word-break",
      "overflow-wrap",
      "text-indent",
      "text-transform",
    ];
    const taStyle = getComputedStyle(ta);
    const styleDiffs: string[] = [];
    for (const [name, el] of [
      ["pre", pre],
      ["code", code],
    ] as const) {
      const cs = getComputedStyle(el);
      for (const p of props) {
        if (cs.getPropertyValue(p) !== taStyle.getPropertyValue(p)) {
          styleDiffs.push(
            `${name} ${p}: ${cs.getPropertyValue(p)} vs textarea ${taStyle.getPropertyValue(p)}`,
          );
        }
      }
    }

    // Content boxes must coincide too, or wrapping points differ.
    const taRect = ta.getBoundingClientRect();
    const pl = parseFloat(taStyle.paddingLeft);
    const pt = parseFloat(taStyle.paddingTop);
    const preRect = pre.getBoundingClientRect();
    const taContentWidth =
      ta.clientWidth - pl - parseFloat(taStyle.paddingRight);
    if (Math.abs(taRect.left + pl - preRect.left) > 0.5)
      styleDiffs.push(`content left ${taRect.left + pl} vs pre ${preRect.left}`);
    if (Math.abs(taRect.top + pt - preRect.top) > 0.5)
      styleDiffs.push(`content top ${taRect.top + pt} vs pre ${preRect.top}`);
    if (Math.abs(taContentWidth - pre.clientWidth) > 0.5)
      styleDiffs.push(`content width ${taContentWidth} vs pre ${pre.clientWidth}`);

    // Mirror of the textarea, laid over it, so we can ask where each glyph goes.
    const mirror = document.createElement("div");
    for (const p of Array.from(taStyle)) {
      mirror.style.setProperty(p, taStyle.getPropertyValue(p));
    }
    mirror.style.position = "fixed";
    mirror.style.left = `${taRect.left}px`;
    mirror.style.top = `${taRect.top - ta.scrollTop}px`;
    mirror.style.width = `${taRect.width}px`;
    mirror.style.height = "auto";
    mirror.style.overflow = "hidden";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.textContent = ta.value;
    document.body.appendChild(mirror);

    const locate = (root: Node) => {
      const map: [Text, number][] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node as Text;
        for (let i = 0; i < text.data.length; i++) map.push([text, i]);
      }
      return map;
    };
    const rectAt = (map: [Text, number][], i: number) => {
      const [node, offset] = map[i];
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      return range.getClientRects()[0] ?? range.getBoundingClientRect();
    };

    const preMap = locate(code);
    const mirrorMap = locate(mirror);
    const preText = code.textContent ?? "";

    let worst = 0;
    const offenders: string[] = [];
    for (let i = 0; i < ta.value.length; i++) {
      const ch = ta.value[i];
      if (/\s/.test(ch)) continue;
      const a = rectAt(mirrorMap, i);
      const b = rectAt(preMap, i);
      const off = Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top));
      if (off > worst) worst = off;
      if (off > 1 && offenders.length < 5) {
        offenders.push(
          `#${i} ${JSON.stringify(ch)} textarea(${a.left.toFixed(1)},${a.top.toFixed(1)}) pre(${b.left.toFixed(1)},${b.top.toFixed(1)})`,
        );
      }
    }
    mirror.remove();

    return {
      valueLength: ta.value.length,
      preMatchesValue: preText.startsWith(ta.value),
      styleDiffs,
      worst,
      offenders,
    };
  }, TEXTAREA);
}

async function expectAligned(page: Page) {
  // Let the highlighter re-render and web fonts settle.
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(async () => {
      const r = await measure(page);
      return r.preMatchesValue;
    })
    .toBe(true);
  const report = await measure(page);
  expect(report.styleDiffs, "textarea and <pre> text styles differ").toEqual([]);
  expect(report.worst, report.offenders.join("\n")).toBeLessThanOrEqual(1);
}

test.describe("editor caret alignment", () => {
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
    const textarea = page.locator(TEXTAREA);
    await expect(textarea).toBeVisible();
    await expectAligned(page);

    // The exact sequence from the bug report: append to the long line, break,
    // then type an indented word.
    const value = await textarea.inputValue();
    const at = value.indexOf("[[wikilinks]].") + "[[wikilinks]].".length;
    await textarea.evaluate((el: HTMLTextAreaElement, pos) => {
      el.focus();
      el.setSelectionRange(pos, pos);
    }, at);
    await page.keyboard.type("ddddd");
    await page.keyboard.press("Enter");
    await page.keyboard.type(" edit");
    await expect(textarea).toHaveValue(/\[\[wikilinks\]\]\.ddddd\n edit/);
    await expectAligned(page);
  });

  test("rich markdown stays aligned in live, edit-only and narrow layouts", async ({
    page,
  }) => {
    noteId = await seedNote(uniqueTitle("Caret Rich"), RICH);
    await page.goto(`/vault/${noteId}`);
    const textarea = page.locator(TEXTAREA);
    await expect(textarea).toBeVisible();
    await expectAligned(page);

    // Typing in the middle of styled tokens re-highlights around the caret.
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      const pos = el.value.indexOf("**Bold words**") + 4;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
    await page.keyboard.type(" more bold text that forces a rewrap");
    await expectAligned(page);

    // Edit-only mode widens the textarea to the full pane.
    await page.locator('.w-md-editor-toolbar button[data-name="edit"]').click();
    await expectAligned(page);
    await page.locator('.w-md-editor-toolbar button[data-name="live"]').click();

    // A narrower window changes every wrap point.
    await page.setViewportSize({ width: 1024, height: 800 });
    await expectAligned(page);
  });
});
