import { test, expect, type Page } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  editorText,
  expectEditorText,
  noteEditor,
  placeCaretAfter,
  readNote,
  replaceEditorText,
  seedNote,
  setEditorSelection,
  uniqueTitle,
} from "./helpers";

/*
 * The note editor's Word-style toolbar (DOQ-34): grouped controls with a
 * paragraph style menu, pressed states, a table picker and image prompt,
 * find and replace, the Source / Live / Reading views and full screen, a
 * More menu at narrow widths, and the status bar's counts. The saved note
 * stays exactly the markdown the commands write.
 */

const ids: string[] = [];

test.afterEach(async () => {
  while (ids.length) await deleteNote(ids.pop()!);
});

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Formatting" });
const tool = (page: Page, name: string) => toolbar(page).getByRole("button", { name, exact: true });
/** The tooltip showing `text` (the one before may still be fading out). */
async function expectTooltip(page: Page, text: string) {
  const shown = page.locator('[data-slot="tooltip-content"]').filter({ hasText: text });
  await expect(shown).toBeVisible();
  await expect(shown).toHaveText(text);
}
const styleMenu = (page: Page) => toolbar(page).getByRole("button", { name: /^Paragraph style/ });

/** Opens a seeded note with room for the whole toolbar (the mindmap hidden). */
async function openNote(page: Page, markdown: string, { wide = true } = {}): Promise<string> {
  const id = await seedNote(uniqueTitle("Toolbar"), markdown);
  ids.push(id);
  await page.goto(`/vault/${id}`);
  if (wide) {
    const hide = page.getByRole("button", { name: "Hide mindmap" });
    await hide.click();
    await expect(page.getByRole("button", { name: "Show mindmap" })).toBeVisible();
  }
  await editableEditor(page);
  return id;
}

test.describe("editor toolbar", () => {
  // Wide enough for the whole bar beside the explorer and the right panel;
  // the More menu has its own test at a narrow width.
  test.use({ viewport: { width: 1920, height: 1000 } });

  test("groups its controls in order, each named, with the platform's shortcut", async ({ page }) => {
    await openNote(page, "Text");
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    const groups = await toolbar(page).locator("[data-group-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-group-id")));
    expect(groups).toEqual(["history", "style", "text", "insert", "lists", "blocks", "clear", "find"]);
    const controls = await toolbar(page)
      .locator("[data-tool-id]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-tool-id")));
    expect(controls).toEqual([
      "undo",
      "redo",
      "style",
      "bold",
      "italic",
      "strike",
      "code",
      "link",
      "wikilink",
      "image",
      "table",
      "bullet",
      "ordered",
      "task",
      "outdent",
      "indent",
      "quote",
      "codeblock",
      "hr",
      "clear",
      "find",
      "view-source",
      "view-live",
      "view-reading",
      "fullscreen",
    ]);
    // Every control has a name.
    for (const control of await toolbar(page).locator("[data-tool-id]").all()) {
      expect(await control.getAttribute("aria-label")).toBeTruthy();
    }
    // Shortcuts in the platform's spelling, in the tooltip and for assistive tech.
    await expect(tool(page, "Bold")).toHaveAttribute("aria-keyshortcuts", mac ? "Meta+B" : "Control+B");
    await expect(tool(page, "Strikethrough")).toHaveAttribute("aria-keyshortcuts", mac ? "Meta+Shift+X" : "Control+Shift+X");
    await tool(page, "Bold").hover();
    await expectTooltip(page, mac ? "Bold (⌘B)" : "Bold (Ctrl+B)");
    await tool(page, "Redo").hover();
    await expectTooltip(page, mac ? "Redo (⇧⌘Z)" : "Redo (Ctrl+Y)");
    await tool(page, "Find and replace").hover();
    await expectTooltip(page, mac ? "Find and replace (⌘F)" : "Find and replace (Ctrl+F)");
  });

  test("the style menu shows the line's style and changes it", async ({ page }) => {
    const id = await openNote(page, "Intro\n\nSecond line");
    await placeCaretAfter(page, "Intro");
    await expect(styleMenu(page)).toHaveText("Normal text");

    await styleMenu(page).click();
    const menu = page.getByRole("menu");
    // Each option is previewed in its own style.
    const size = (name: RegExp) =>
      menu
        .getByRole("menuitemradio", { name })
        .locator("[data-style-preview]")
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const h1Size = await size(/^Heading 1/);
    const normalSize = await size(/^Normal text/);
    expect(h1Size).toBeGreaterThan(normalSize);
    await expect(menu.getByRole("menuitemradio")).toHaveText([
      /^Normal text/,
      /^Heading 1/,
      /^Heading 2/,
      /^Heading 3/,
      /^Heading 4/,
      /^Heading 5/,
      /^Heading 6/,
      /^Quote/,
      /^Code block/,
    ]);
    await menu.getByRole("menuitemradio", { name: /^Heading 1/ }).click();
    await expectEditorText(page, "# Intro\n\nSecond line");
    await expect(styleMenu(page)).toHaveText("Heading 1");

    await styleMenu(page).click();
    await page.getByRole("menuitemradio", { name: /^Quote/ }).click();
    await expectEditorText(page, "> Intro\n\nSecond line");
    await expect(styleMenu(page)).toHaveText("Quote");

    await styleMenu(page).click();
    await page.getByRole("menuitemradio", { name: /^Code block/ }).click();
    await expectEditorText(page, "```\nIntro\n```\n\nSecond line");
    await expect(styleMenu(page)).toHaveText("Code block");

    await styleMenu(page).click();
    await page.getByRole("menuitemradio", { name: /^Normal text/ }).click();
    await expectEditorText(page, "Intro\n\nSecond line");

    // The label follows the caret's line.
    await replaceEditorText(page, "## Two\n\nplain");
    await setEditorSelection(page, 3);
    await expect(styleMenu(page)).toHaveText("Heading 2");
    await setEditorSelection(page, -1);
    await expect(styleMenu(page)).toHaveText("Normal text");

    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await readNote(id)).markdown).toBe("## Two\n\nplain");
  });

  test("buttons show pressed inside their formatting and toggle it off cleanly", async ({ page }) => {
    await openNote(page, "a **bold** b *it* c ~~gone~~ d `code`\n\n- item\n\n1. first\n\n- [ ] todo\n\n> quoted");
    const caretIn = async (word: string) => setEditorSelection(page, (await editorText(page)).indexOf(word) + 2);

    await caretIn("bold");
    await expect(tool(page, "Bold")).toHaveAttribute("aria-pressed", "true");
    await expect(tool(page, "Italic")).toHaveAttribute("aria-pressed", "false");
    await caretIn("it*");
    await expect(tool(page, "Italic")).toHaveAttribute("aria-pressed", "true");
    await expect(tool(page, "Bold")).toHaveAttribute("aria-pressed", "false");
    await caretIn("gone");
    await expect(tool(page, "Strikethrough")).toHaveAttribute("aria-pressed", "true");
    await caretIn("code`");
    await expect(tool(page, "Inline code")).toHaveAttribute("aria-pressed", "true");
    await caretIn("item");
    await expect(tool(page, "Bulleted list")).toHaveAttribute("aria-pressed", "true");
    await expect(tool(page, "Numbered list")).toHaveAttribute("aria-pressed", "false");
    await caretIn("first");
    await expect(tool(page, "Numbered list")).toHaveAttribute("aria-pressed", "true");
    await caretIn("todo");
    await expect(tool(page, "Checklist")).toHaveAttribute("aria-pressed", "true");
    await expect(tool(page, "Bulleted list")).toHaveAttribute("aria-pressed", "false");
    await caretIn("quoted");
    await expect(tool(page, "Blockquote")).toHaveAttribute("aria-pressed", "true");

    // Off again, one by one: only the markers go.
    await caretIn("bold");
    await tool(page, "Bold").click();
    await caretIn("it*");
    await tool(page, "Italic").click();
    await caretIn("gone");
    await tool(page, "Strikethrough").click();
    await caretIn("code`");
    await tool(page, "Inline code").click();
    await caretIn("item");
    await tool(page, "Bulleted list").click();
    await caretIn("first");
    await tool(page, "Numbered list").click();
    await caretIn("todo");
    await tool(page, "Checklist").click();
    await caretIn("quoted");
    await tool(page, "Blockquote").click();
    await expectEditorText(page, "a bold b it c gone d code\n\nitem\n\nfirst\n\ntodo\n\nquoted");
    await expect(tool(page, "Bold")).toHaveAttribute("aria-pressed", "false");
  });

  test("with a bare caret in a word, bold and italic wrap the word", async ({ page }) => {
    await openNote(page, "one word here");
    await setEditorSelection(page, 6);
    await tool(page, "Bold").click();
    await expectEditorText(page, "one **word** here");
    await tool(page, "Italic").click();
    await expectEditorText(page, "one ***word*** here");
    await tool(page, "Bold").click();
    await expectEditorText(page, "one *word* here");
    await tool(page, "Italic").click();
    await expectEditorText(page, "one word here");
  });

  test("the table picker inserts a GFM table that renders once the caret leaves", async ({ page }) => {
    await openNote(page, "Intro");
    await placeCaretAfter(page, "Intro");
    await tool(page, "Table").click();
    const picker = page.getByRole("dialog");
    await picker.getByRole("button", { name: "3 by 2 table" }).hover();
    await expect(picker).toContainText("3 × 2");
    await picker.getByRole("button", { name: "3 by 2 table" }).click();
    await expect(picker).toBeHidden();
    const table = "| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n|          |          |          |";
    await expectEditorText(page, `Intro\n\n${table}\n`);
    // The caret is in the table, typing over the first header.
    await page.keyboard.type("Name");
    await expectEditorText(page, `Intro\n\n${table.replace("Column 1", "Name")}\n`);
    await setEditorSelection(page, 0);
    const grid = noteEditor(page).locator("table.cm-lp-table");
    await expect(grid).toBeVisible();
    await expect(grid.locator("th")).toHaveText(["Name", "Column 2", "Column 3"]);
    await expect(grid.locator("tbody tr")).toHaveCount(1);
  });

  test("the image prompt takes only an http(s) address, and alt text", async ({ page }) => {
    await page.route("https://images.e2e.invalid/**", (route) => route.fulfill({ status: 404 }));
    await openNote(page, "Pic: ");
    await setEditorSelection(page, -1);
    await tool(page, "Image").click();
    const prompt = page.getByRole("dialog");
    await prompt.getByLabel("Image address").fill("javascript:alert(1)");
    await prompt.getByLabel("Alt text").fill("A cat");
    await prompt.getByRole("button", { name: "Insert image" }).click();
    await expect(prompt.getByRole("alert")).toContainText("https://");
    expect(await editorText(page)).toBe("Pic: ");

    await prompt.getByLabel("Image address").fill("https://images.e2e.invalid/cat.png");
    await prompt.getByRole("button", { name: "Insert image" }).click();
    await expect(prompt).toBeHidden();
    await expectEditorText(page, "Pic: ![A cat](https://images.e2e.invalid/cat.png)");
  });

  test("the shortcuts format, style, list, indent, clear and undo", async ({ page }) => {
    await openNote(page, "word");
    const select = async () => setEditorSelection(page, 0, (await editorText(page)).length);

    await select();
    await page.keyboard.press("ControlOrMeta+Shift+x");
    await expectEditorText(page, "~~word~~");
    await page.keyboard.press("ControlOrMeta+Shift+x");
    await expectEditorText(page, "word");

    await page.keyboard.press("ControlOrMeta+Alt+1");
    await expectEditorText(page, "# word");
    await page.keyboard.press("ControlOrMeta+Alt+3");
    await expectEditorText(page, "### word");
    await page.keyboard.press("ControlOrMeta+Alt+0");
    await expectEditorText(page, "word");

    await page.keyboard.press("ControlOrMeta+Shift+8");
    await expectEditorText(page, "- word");
    await page.keyboard.press("ControlOrMeta+Shift+7");
    await expectEditorText(page, "1. word");
    await page.keyboard.press("ControlOrMeta+Shift+9");
    await expectEditorText(page, "- [ ] word");
    await page.keyboard.press("ControlOrMeta+Shift+8");
    await expectEditorText(page, "- word");

    await replaceEditorText(page, "- one\n- two");
    await setEditorSelection(page, -1);
    await page.keyboard.press("ControlOrMeta+]");
    await expectEditorText(page, "- one\n  - two");
    await page.keyboard.press("ControlOrMeta+[");
    await expectEditorText(page, "- one\n- two");
    // ⌘[ is the editor's, not the browser's Back.
    expect(new URL(page.url()).pathname).toMatch(/^\/vault\//);

    await replaceEditorText(page, "## **Bold** and [link](https://example.com)");
    await select();
    await page.keyboard.press("ControlOrMeta+\\");
    await expectEditorText(page, "Bold and link");

    await page.keyboard.press("ControlOrMeta+z");
    await expectEditorText(page, "## **Bold** and [link](https://example.com)");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expectEditorText(page, "Bold and link");
    await page.keyboard.press("ControlOrMeta+z");
    await expectEditorText(page, "## **Bold** and [link](https://example.com)");
    await page.keyboard.press("Control+y");
    await expectEditorText(page, "Bold and link");
  });

  test("⌘K and ⌘N outside the editor still open the switcher and make a note", async ({ page }) => {
    const id = await openNote(page, "Text");
    const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await blur();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByPlaceholder("Go to note…")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder("Go to note…")).toBeHidden();

    // In the editor, ⌘K is a link and nothing else.
    await setEditorSelection(page, 0, 4);
    await page.keyboard.press("ControlOrMeta+k");
    await expectEditorText(page, "[Text](url)");
    await expect(page.getByPlaceholder("Go to note…")).toBeHidden();

    await blur();
    await page.keyboard.press("ControlOrMeta+n");
    await page.waitForURL((url) => /^\/vault\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(id));
    ids.push(new URL(page.url()).pathname.split("/")[2]);
  });

  test("find and replace opens from the keyboard, matches the theme, and replaces all in one undo", async ({ page }) => {
    await openNote(page, "cat and cat and cat");
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await setEditorSelection(page, 0);
    await page.keyboard.press("ControlOrMeta+f");
    const panel = page.locator(".cm-search");
    await expect(panel).toBeVisible();
    await expect(panel.locator("input[name=search]")).toBeFocused();
    await expect(tool(page, "Find and replace")).toHaveAttribute("aria-pressed", "true");
    // The app's dark glass, not CodeMirror's light default.
    const look = await panel.evaluate((el) => {
      const field = el.querySelector("input[name=search]")!;
      return {
        panel: getComputedStyle(el.closest(".cm-panels")!).backgroundColor,
        page: getComputedStyle(document.body).backgroundColor,
        field: getComputedStyle(field).color,
        button: getComputedStyle(el.querySelector("button")!).backgroundImage,
      };
    });
    expect(look.panel).toBe(look.page);
    expect(look.field).toBe("rgb(244, 245, 247)");
    expect(look.button).toBe("none");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    await setEditorSelection(page, 0);
    await page.keyboard.press(mac ? "Meta+Alt+f" : "Control+h");
    await expect(panel.locator("input[name=replace]")).toBeFocused();
    await panel.locator("input[name=search]").fill("cat");
    await panel.locator("input[name=replace]").fill("dog");
    await panel.getByRole("button", { name: "Replace all" }).click();
    await expectEditorText(page, "dog and dog and dog");

    // One undo step brings every match back.
    await setEditorSelection(page, 0);
    await page.keyboard.press("ControlOrMeta+z");
    await expectEditorText(page, "cat and cat and cat");
  });

  test("Source, Live and Reading views work, and the choice survives a reload", async ({ page, context }) => {
    const otherTitle = uniqueTitle("Toolbar target");
    const otherId = await seedNote(otherTitle, `# ${otherTitle}\n\nHere.`);
    ids.push(otherId);
    await context.route("https://example.com/**", (route) => route.fulfill({ status: 200, body: "ok" }));
    await openNote(page, `# Heading\n\nSee [[${otherTitle}]] and [the site](https://example.com/page).`);
    await setEditorSelection(page, -1);
    await expect(tool(page, "Live")).toHaveAttribute("aria-pressed", "true");
    const heading = noteEditor(page).locator(".cm-line").first();
    await expect(heading).toHaveText("Heading");

    await tool(page, "Source").click();
    await expect(tool(page, "Source")).toHaveAttribute("aria-pressed", "true");
    // Raw markdown everywhere, not only on the caret's line.
    await expect(heading).toHaveText("# Heading");
    await expect(noteEditor(page)).toContainText(`[[${otherTitle}]]`);
    await expect(noteEditor(page)).toContainText("[the site](https://example.com/page)");

    await tool(page, "Reading").click();
    await expect(noteEditor(page)).toHaveAttribute("contenteditable", "false");
    await expect(heading).toHaveText("Heading");
    // Formatting is off; the views and find still work.
    await expect(tool(page, "Bold")).toBeDisabled();
    await expect(tool(page, "Find and replace")).toBeEnabled();

    await page.reload();
    await expect(tool(page, "Reading")).toHaveAttribute("aria-pressed", "true");
    await expect(noteEditor(page)).toHaveAttribute("contenteditable", "false");
    // No caret: nothing editable, and no drawn cursor showing.
    await expect(page.locator(".cm-cursor")).toBeHidden();

    // A plain click follows: the web link opens in a new tab…
    const popup = page.waitForEvent("popup");
    await noteEditor(page).locator(".cm-lp-link", { hasText: "the site" }).click();
    expect((await popup).url()).toBe("https://example.com/page");
    // …and the wikilink opens its note.
    await noteEditor(page).locator(".cm-lp-wikilink").click();
    await page.waitForURL(`**/vault/${otherId}`);

    await tool(page, "Live").click();
    await editableEditor(page);
    await page.reload();
    await expect(tool(page, "Live")).toHaveAttribute("aria-pressed", "true");
    await editableEditor(page);
  });

  test("full screen fills the window and Esc exits it", async ({ page }) => {
    await openNote(page, "Text");
    await setEditorSelection(page, -1);
    await tool(page, "Full screen").click();
    await expect(tool(page, "Full screen")).toHaveAttribute("aria-pressed", "true");
    const root = page.locator(".doqtri-editor[data-fullscreen]");
    await expect(root).toBeVisible();
    const box = (await root.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    // On top of everything: the vault's chrome is covered.
    const onTop = await page.evaluate(() => {
      const hit = document.elementFromPoint(window.innerWidth - 5, window.innerHeight - 5);
      return !!hit?.closest(".doqtri-editor");
    });
    expect(onTop).toBe(true);
    // Typing still works in full screen.
    await page.keyboard.type(" more");
    await expectEditorText(page, "Text more");

    await page.keyboard.press("Escape");
    await expect(root).toHaveCount(0);
    await expect(tool(page, "Full screen")).toHaveAttribute("aria-pressed", "false");

    // And the button exits too.
    await tool(page, "Full screen").click();
    await expect(root).toBeVisible();
    await tool(page, "Full screen").click();
    await expect(root).toHaveCount(0);
  });

  test("at a narrow width, groups fold into a More menu without wrapping or page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openNote(page, "Text", { wide: false });
    const more = toolbar(page).getByRole("button", { name: "More formatting" });
    await expect(more).toBeVisible();
    // Folded from the right: the first groups stay, the last ones go.
    await expect(tool(page, "Undo")).toBeVisible();
    await expect(tool(page, "Find and replace")).toHaveCount(0);
    // One row: nothing wraps, nothing overflows the bar or the page.
    const fits = await toolbar(page).evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      overflow: el.scrollWidth - el.clientWidth,
      page: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(fits.height).toBeLessThanOrEqual(41);
    expect(fits.overflow).toBeLessThanOrEqual(0);
    expect(fits.page).toBeLessThanOrEqual(0);

    await setEditorSelection(page, 0, 4);
    await more.click();
    const menu = page.getByRole("menu");
    // A toggle stays a toggle in the menu.
    await expect(menu.getByRole("menuitemcheckbox", { name: /^Find and replace/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Clear formatting/ })).toBeVisible();
    await menu.getByRole("menuitemcheckbox", { name: /^Find and replace/ }).click();
    await expect(page.locator(".cm-search")).toBeVisible();

    // Wider again: everything comes back out.
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.getByRole("button", { name: "Hide mindmap" }).click();
    await expect(tool(page, "Find and replace")).toBeVisible();
    await expect(more).toHaveCount(0);
  });

  test("is one keyboard stop, with arrow keys between controls and a visible focus ring", async ({ page }) => {
    await openNote(page, "Text");
    await expect(toolbar(page).locator('[tabindex="0"]')).toHaveCount(1);
    await setEditorSelection(page, -1);
    await page.keyboard.press("Shift+Tab");
    await expect(tool(page, "Undo")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tool(page, "Redo")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(styleMenu(page)).toBeFocused();
    await page.keyboard.press("End");
    await expect(tool(page, "Full screen")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tool(page, "Undo")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tool(page, "Full screen")).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(tool(page, "Bold")).toBeFocused();
    // The last control used keeps the one tab stop.
    await expect(toolbar(page).locator('[tabindex="0"]')).toHaveCount(1);
    await expect(tool(page, "Bold")).toHaveAttribute("tabindex", "0");
    const ring = await tool(page, "Bold").evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring).not.toBe("none");
    // Space on a focused button formats the text, as a click does.
    await page.keyboard.press("Space");
    await expectEditorText(page, "Text****");

    // Icons and labels clear 4.5:1 against the page in the dark theme.
    const ratios = await toolbar(page).evaluate((bar) => {
      const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const lum = (c: number[]) => {
        const [r, g, b] = c.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const bg = lum(rgb(getComputedStyle(document.body).backgroundColor));
      return [...bar.querySelectorAll<HTMLElement>("[data-tool-id]:not(:disabled)")].map((el) => {
        const fg = lum(rgb(getComputedStyle(el).color));
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
    });
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
  });

  test("the status bar shows words, characters and line:col, and the selection's counts", async ({ page }) => {
    await openNote(page, "one two three\nfour");
    await setEditorSelection(page, -1);
    const status = page.getByRole("contentinfo");
    await expect(status.getByTestId("status-words")).toHaveText("4 words");
    await expect(status.getByTestId("status-chars")).toHaveText("18 characters");
    await expect(status.getByTestId("status-cursor")).toHaveText("Ln 2, Col 5");

    await setEditorSelection(page, 4, 13);
    await expect(status.getByTestId("status-words")).toHaveText("2 of 4 words");
    await expect(status.getByTestId("status-chars")).toHaveText("9 of 18 characters");
    await expect(status.getByTestId("status-cursor")).toHaveText("Ln 1, Col 14");
  });

  test("wikilink inserts brackets and opens the note list", async ({ page }) => {
    const otherTitle = uniqueTitle("Toolbar linked");
    ids.push(await seedNote(otherTitle, "Body"));
    await openNote(page, "See ");
    await setEditorSelection(page, -1);
    await tool(page, "Wikilink").click();
    await expectEditorText(page, "See [[]]");
    const list = page.locator(".cm-wikilink-suggest");
    await expect(list).toBeVisible();
    await page.keyboard.type(otherTitle.slice(0, 14));
    await expect(list.getByRole("option", { name: otherTitle })).toBeVisible();
    await list.getByRole("option", { name: otherTitle }).click();
    await expectEditorText(page, `See [[${otherTitle}]]`);
  });
});
