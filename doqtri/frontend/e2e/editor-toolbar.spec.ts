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
 *
 * Every note opens with its title line (D-120), so each test's text starts
 * below it: `head` is that line and the blank line after it, and positions
 * and expected text are counted from there (`at`, `body`).
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
const viewMenu = (page: Page) => toolbar(page).getByRole("button", { name: /^View:/ });
/** Picks Source, Live or Reading from the View menu. */
async function chooseView(page: Page, name: "Source" | "Live" | "Reading") {
  await viewMenu(page).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
  await expect(viewMenu(page)).toHaveAttribute("aria-label", `View: ${name}`);
}
const styleMenu = (page: Page) => toolbar(page).getByRole("button", { name: /^Paragraph style/ });

/** The open note's title line and the blank line under it. */
let head = "";
/** The note's title, as its title line says it. */
let noteTitle = "";
/** A position in the test's own text, below the title line. */
const at = (pos: number) => head.length + pos;
/** The whole note, for the test's own text. */
const body = (text: string) => head + text;

/** Seeds a note titled after `prefix` whose text is `markdown` under its title line. */
async function seedWithTitle(prefix: string, markdown: string): Promise<string> {
  noteTitle = uniqueTitle(prefix);
  head = `# ${noteTitle}\n\n`;
  const id = await seedNote(noteTitle, body(markdown));
  ids.push(id);
  return id;
}

/** Opens a seeded note with room for the whole toolbar (the mindmap hidden). */
async function openNote(page: Page, markdown: string, { wide = true } = {}): Promise<string> {
  const id = await seedWithTitle("Toolbar", markdown);
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
      "view",
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
    await expectEditorText(page, body("# Intro\n\nSecond line"));
    await expect(styleMenu(page)).toHaveText("Heading 1");

    await styleMenu(page).click();
    await page.getByRole("menuitemradio", { name: /^Quote/ }).click();
    await expectEditorText(page, body("> Intro\n\nSecond line"));
    await expect(styleMenu(page)).toHaveText("Quote");

    await styleMenu(page).click();
    await page.getByRole("menuitemradio", { name: /^Code block/ }).click();
    await expectEditorText(page, body("```\nIntro\n```\n\nSecond line"));
    await expect(styleMenu(page)).toHaveText("Code block");

    await styleMenu(page).click();
    await page.getByRole("menuitemradio", { name: /^Normal text/ }).click();
    await expectEditorText(page, body("Intro\n\nSecond line"));

    // The label follows the caret's line.
    await replaceEditorText(page, body("## Two\n\nplain"));
    await setEditorSelection(page, at(3));
    await expect(styleMenu(page)).toHaveText("Heading 2");
    await setEditorSelection(page, -1);
    await expect(styleMenu(page)).toHaveText("Normal text");

    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await readNote(id)).markdown).toBe(body("## Two\n\nplain"));
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
    await expectEditorText(page, body("a bold b it c gone d code\n\nitem\n\nfirst\n\ntodo\n\nquoted"));
    await expect(tool(page, "Bold")).toHaveAttribute("aria-pressed", "false");
  });

  test("with a bare caret in a word, bold and italic wrap the word", async ({ page }) => {
    await openNote(page, "one word here");
    await setEditorSelection(page, at(6));
    await tool(page, "Bold").click();
    await expectEditorText(page, body("one **word** here"));
    await tool(page, "Italic").click();
    await expectEditorText(page, body("one ***word*** here"));
    await tool(page, "Bold").click();
    await expectEditorText(page, body("one *word* here"));
    await tool(page, "Italic").click();
    await expectEditorText(page, body("one word here"));
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
    // With a blank line after it, so what is typed next does not join it.
    await expectEditorText(page, body(`Intro\n\n${table}\n\n`));
    // The caret is in the table, typing over the first header.
    await page.keyboard.type("Name");
    await expectEditorText(page, body(`Intro\n\n${table.replace("Column 1", "Name")}\n\n`));
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
    expect(await editorText(page)).toBe(body("Pic: "));

    await prompt.getByLabel("Image address").fill("https://images.e2e.invalid/cat.png");
    await prompt.getByRole("button", { name: "Insert image" }).click();
    await expect(prompt).toBeHidden();
    await expectEditorText(page, body("Pic: ![A cat](https://images.e2e.invalid/cat.png)"));
  });

  test("the shortcuts format, style, list, indent, clear and undo", async ({ page }) => {
    await openNote(page, "word");
    const select = async () => setEditorSelection(page, at(0), (await editorText(page)).length);

    await select();
    await page.keyboard.press("ControlOrMeta+Shift+x");
    await expectEditorText(page, body("~~word~~"));
    await page.keyboard.press("ControlOrMeta+Shift+x");
    await expectEditorText(page, body("word"));

    await page.keyboard.press("ControlOrMeta+Alt+1");
    await expectEditorText(page, body("# word"));
    await page.keyboard.press("ControlOrMeta+Alt+3");
    await expectEditorText(page, body("### word"));
    await page.keyboard.press("ControlOrMeta+Alt+0");
    await expectEditorText(page, body("word"));

    await page.keyboard.press("ControlOrMeta+Shift+8");
    await expectEditorText(page, body("- word"));
    await page.keyboard.press("ControlOrMeta+Shift+7");
    await expectEditorText(page, body("1. word"));
    await page.keyboard.press("ControlOrMeta+Shift+9");
    await expectEditorText(page, body("- [ ] word"));
    await page.keyboard.press("ControlOrMeta+Shift+8");
    await expectEditorText(page, body("- word"));

    await replaceEditorText(page, body("- one\n- two"));
    await setEditorSelection(page, -1);
    await page.keyboard.press("ControlOrMeta+]");
    await expectEditorText(page, body("- one\n  - two"));
    await page.keyboard.press("ControlOrMeta+[");
    await expectEditorText(page, body("- one\n- two"));
    // ⌘[ is the editor's, not the browser's Back.
    expect(new URL(page.url()).pathname).toMatch(/^\/vault\//);

    await replaceEditorText(page, body("## **Bold** and [link](https://example.com)"));
    await select();
    await page.keyboard.press("ControlOrMeta+\\");
    await expectEditorText(page, body("Bold and link"));

    await page.keyboard.press("ControlOrMeta+z");
    await expectEditorText(page, body("## **Bold** and [link](https://example.com)"));
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expectEditorText(page, body("Bold and link"));
    await page.keyboard.press("ControlOrMeta+z");
    await expectEditorText(page, body("## **Bold** and [link](https://example.com)"));
    await page.keyboard.press("Control+y");
    await expectEditorText(page, body("Bold and link"));
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
    await setEditorSelection(page, at(0), at(4));
    await page.keyboard.press("ControlOrMeta+k");
    await expectEditorText(page, body("[Text](url)"));
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
    await expectEditorText(page, body("dog and dog and dog"));

    // One undo step brings every match back.
    await setEditorSelection(page, 0);
    await page.keyboard.press("ControlOrMeta+z");
    await expectEditorText(page, body("cat and cat and cat"));
  });

  test("Source, Live and Reading views work, and the choice survives a reload", async ({ page, context }) => {
    const otherTitle = uniqueTitle("Toolbar target");
    const otherId = await seedNote(otherTitle, `# ${otherTitle}\n\nHere.`);
    ids.push(otherId);
    await context.route("https://example.com/**", (route) => route.fulfill({ status: 200, body: "ok" }));
    await openNote(page, `# Heading\n\nSee [[${otherTitle}]] and [the site](https://example.com/page).`);
    await setEditorSelection(page, -1);
    await expect(viewMenu(page)).toHaveAttribute("aria-label", "View: Live");
    const heading = noteEditor(page).locator(".cm-line").filter({ hasText: /^(# )?Heading$/ });
    await expect(heading).toHaveText("Heading");

    await chooseView(page, "Source");
    // Raw markdown everywhere, not only on the caret's line.
    await expect(heading).toHaveText("# Heading");
    await expect(noteEditor(page)).toContainText(`[[${otherTitle}]]`);
    await expect(noteEditor(page)).toContainText("[the site](https://example.com/page)");

    await chooseView(page, "Reading");
    await expect(noteEditor(page)).toHaveAttribute("contenteditable", "false");
    await expect(heading).toHaveText("Heading");
    // Formatting is off; the views and find still work.
    await expect(tool(page, "Bold")).toBeDisabled();
    await expect(tool(page, "Find and replace")).toBeEnabled();

    await page.reload();
    await expect(viewMenu(page)).toHaveAttribute("aria-label", "View: Reading");
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

    await chooseView(page, "Live");
    await editableEditor(page);
    await page.reload();
    await expect(viewMenu(page)).toHaveAttribute("aria-label", "View: Live");
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
    await expectEditorText(page, body("Text more"));

    await page.keyboard.press("Escape");
    await expect(root).toHaveCount(0);
    await expect(tool(page, "Full screen")).toHaveAttribute("aria-pressed", "false");

    // Modal while on: a labelled dialog, Tab stays inside, the rest is inert.
    await tool(page, "Full screen").click();
    await expect(page.getByRole("dialog", { name: "Full screen editor" })).toBeVisible();
    const inert = () => page.getByRole("button", { name: "New note" }).evaluate((el) => !!el.closest("[inert]"));
    expect(await inert()).toBe(true);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => ({
        inside: !!document.activeElement?.closest(".doqtri-editor[data-fullscreen]"),
        what: document.activeElement?.outerHTML.slice(0, 160) ?? "nothing",
      }));
      expect(focus.inside, `Tab ${i + 1} reached ${focus.what}`).toBe(true);
    }
    // Esc closes the find panel first, and only then full screen.
    await setEditorSelection(page, 0);
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.locator(".cm-search")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".cm-search")).toHaveCount(0);
    await expect(root).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(root).toHaveCount(0);
    // Back out: the page is reachable again, and focus is back in the note.
    expect(await inert()).toBe(false);
    expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
    expect(await page.evaluate(() => !!document.activeElement?.closest(".doqtri-editor"))).toBe(true);

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
    // The View menu at the end is in reach, not clipped off.
    const bar = (await toolbar(page).boundingBox())!;
    const view = (await viewMenu(page).boundingBox())!;
    expect(view.x + view.width).toBeLessThanOrEqual(bar.x + bar.width);

    await setEditorSelection(page, at(0), at(4));
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
    await expectEditorText(page, body("Text****"));

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

  test("in full screen the style menu and the table picker still work", async ({ page }) => {
    await openNote(page, "Title");
    await setEditorSelection(page, at(2));
    await tool(page, "Full screen").click();
    await expect(page.getByRole("dialog", { name: "Full screen editor" })).toBeVisible();
    // Menus and popovers open above the overlay, and their choices apply.
    await styleMenu(page).click();
    await page.getByRole("menuitemradio", { name: /^Heading 1/ }).click();
    await expectEditorText(page, body("# Title"));
    await setEditorSelection(page, -1);
    await tool(page, "Table").click();
    await page.getByRole("dialog", { name: "Insert table" }).getByRole("button", { name: "2 by 2 table" }).click();
    await expectEditorText(page, body("# Title\n\n| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |\n\n"));
    await expect(page.getByRole("dialog", { name: "Full screen editor" })).toBeVisible();
    // The insert hands focus back to the text, where Esc ends full screen.
    await expect(noteEditor(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Full screen editor" })).toHaveCount(0);
  });

  test("full screen ends when someone takes the note over, with the banner in reach", async ({ page, context }) => {
    test.setTimeout(90_000);
    const id = await openNote(page, "Mine");
    await setEditorSelection(page, -1);
    await page.keyboard.type(" first");
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
    await tool(page, "Full screen").click();
    const overlay = page.getByRole("dialog", { name: "Full screen editor" });
    await expect(overlay).toBeVisible();

    // The same account in another tab takes the lock with "Edit here".
    const other = await context.newPage();
    try {
      await other.goto(`/vault/${id}`);
      await other.getByTestId("edit-lock-elsewhere-banner").getByRole("button", { name: "Edit here" }).click();
      await editableEditor(other);

      // This copy learns on its next save, turns read-only, and leaves full screen.
      await page.keyboard.type(" late");
      await expect(overlay).toHaveCount(0, { timeout: 30_000 });
      await expect(noteEditor(page)).toHaveAttribute("contenteditable", "false");
      expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
      await expect(page.getByTestId("edit-lock-elsewhere-banner")).toBeVisible();
      // Focus is kept near the note, not dropped on the page.
      expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    } finally {
      await other.close();
    }
  });

  test("the status bar counts the rendered text, not the markdown", async ({ page }) => {
    await openNote(page, "# Title **bold**\n\n- [a link](https://example.com/long/address) here\n\n| x | y |\n| - | - |");
    await setEditorSelection(page, -1);
    const status = page.getByRole("contentinfo");
    // Title, bold, a, link, here, x, y.
    // The title line's words count too.
    const words = 7 + noteTitle.split(" ").length;
    await expect(status.getByTestId("status-words")).toHaveText(`${words} words`);
    await setEditorSelection(page, at(0), at(16));
    await expect(status.getByTestId("status-words")).toHaveText(`2 of ${words} words`);
    await expect(status.getByTestId("status-chars")).toHaveText(/^10 of /);
  });

  test("the status bar shows words, characters and line:col, and the selection's counts", async ({ page }) => {
    await openNote(page, "one two three\nfour");
    await setEditorSelection(page, -1);
    const status = page.getByRole("contentinfo");
    // The title line (its text, not its `# `) counts too, two lines up.
    const words = 4 + noteTitle.split(" ").length;
    const chars = 17 + noteTitle.length;
    await expect(status.getByTestId("status-words")).toHaveText(`${words} words`);
    // Characters with spaces, not line breaks, as Word counts them.
    await expect(status.getByTestId("status-chars")).toHaveText(`${chars} characters`);
    await expect(status.getByTestId("status-cursor")).toHaveText("Ln 4, Col 5");

    await setEditorSelection(page, at(4), at(13));
    await expect(status.getByTestId("status-words")).toHaveText(`2 of ${words} words`);
    await expect(status.getByTestId("status-chars")).toHaveText(`9 of ${chars} characters`);
    await expect(status.getByTestId("status-cursor")).toHaveText("Ln 3, Col 14");
  });

  test("wikilink inserts brackets and opens the note list", async ({ page }) => {
    const otherTitle = uniqueTitle("Toolbar linked");
    ids.push(await seedNote(otherTitle, "Body"));
    await openNote(page, "See ");
    await setEditorSelection(page, -1);
    await tool(page, "Wikilink").click();
    await expectEditorText(page, body("See [[]]"));
    const list = page.locator(".cm-wikilink-suggest");
    await expect(list).toBeVisible();
    await page.keyboard.type(otherTitle.slice(0, 14));
    await expect(list.getByRole("option", { name: otherTitle })).toBeVisible();
    await list.getByRole("option", { name: otherTitle }).click();
    await expectEditorText(page, body(`See [[${otherTitle}]]`));
  });
});

test.describe("editor toolbar at the default layout", () => {
  // 1440×900 with the explorer, the right panel and the live mindmap all open.
  test("keeps the everyday tools on the bar and folds the rest into More", async ({ page }) => {
    const id = await seedWithTitle("Toolbar default", "Text");
    // Whether the unfolded bar was ever on the page between React's commits
    // (a frame of it painted before the fold): watched from the first render.
    await page.addInitScript(() => {
      const seen = { unfolded: false };
      (window as unknown as { __toolbarSeen: typeof seen }).__toolbarSeen = seen;
      new MutationObserver(() => {
        if (document.querySelector('[role="toolbar"] [data-tool-id="find"]')) seen.unfolded = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`/vault/${id}`);
    await editableEditor(page);
    await expect(page.getByTestId("live-mindmap")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __toolbarSeen: { unfolded: boolean } }).__toolbarSeen.unfolded)).toBe(false);
    const width = await toolbar(page).evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThan(600);
    const shownIds = () =>
      toolbar(page)
        .locator("[data-tool-id]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-tool-id")!));

    // The everyday tools are all there; what folded, folded by priority.
    const everyday = ["undo", "redo", "style", "bold", "italic", "link", "bullet", "ordered"];
    const fold = ["find", "clear", "hr", "codeblock", "table", "image", "wikilink", "task", "indent", "outdent", "strike", "code", "quote"];
    const shown = await shownIds();
    expect(shown).toEqual(expect.arrayContaining([...everyday, "more", "view"]));
    const folded = fold.filter((id) => !shown.includes(id));
    expect(folded).toEqual(fold.slice(0, folded.length));
    expect(folded.length).toBeGreaterThanOrEqual(10);
    // The style menu is down to its ¶, still named with the line's style.
    await setEditorSelection(page, -1);
    await expect(styleMenu(page)).toHaveAccessibleName("Paragraph style: Normal text");
    // Nothing wraps or spills.
    const fits = await toolbar(page).evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      overflow: el.scrollWidth - el.clientWidth,
      page: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(fits.height).toBeLessThanOrEqual(41);
    expect(fits.overflow).toBeLessThanOrEqual(0);
    expect(fits.page).toBeLessThanOrEqual(0);

    // At a 400px pane, exactly the everyday tools are left; all the rest is
    // in More, in the bar's own group order.
    const barWidth = () => toolbar(page).evaluate((el) => el.getBoundingClientRect().width);
    for (let viewport = 1420; viewport >= 1100 && (await barWidth()) > 400; viewport -= 20) {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.waitForTimeout(100);
    }
    expect(await barWidth()).toBeLessThanOrEqual(400);
    expect(await barWidth()).toBeGreaterThan(370);
    await expect
      .poll(shownIds)
      .toEqual(["undo", "redo", "style", "bold", "italic", "link", "bullet", "ordered", "more", "view"]);
    await toolbar(page).getByRole("button", { name: "More formatting" }).click();
    const items = page.getByRole("menu").locator('[role="menuitem"], [role="menuitemcheckbox"]');
    await expect(items).toHaveText([
      /^Strikethrough/,
      /^Inline code/,
      /^Wikilink/,
      /^Image/,
      /^Table/,
      /^Checklist/,
      /^Decrease indent/,
      /^Increase indent/,
      /^Blockquote/,
      /^Code block/,
      /^Horizontal line/,
      /^Clear formatting/,
      /^Find and replace/,
    ]);
    // A folded tool works from the menu: strikethrough on the word.
    await page.keyboard.press("Escape");
    await setEditorSelection(page, at(0), at(4));
    await toolbar(page).getByRole("button", { name: "More formatting" }).click();
    await page.getByRole("menuitemcheckbox", { name: /^Strikethrough/ }).click();
    await expectEditorText(page, body("~~Text~~"));
    // Full screen lives in the View menu at this width.
    await viewMenu(page).click();
    await page.getByRole("menuitemcheckbox", { name: /^Full screen/ }).click();
    await expect(page.getByRole("dialog", { name: "Full screen editor" })).toBeVisible();
    // Full screen is wide: the tools come back out, with a button to leave.
    await expect(tool(page, "Find and replace")).toBeVisible();
    await tool(page, "Full screen").click();
    await expect(page.getByRole("dialog", { name: "Full screen editor" })).toHaveCount(0);
  });

  test("while the lock reloads, undo, redo and the other shortcuts change nothing", async ({ page }) => {
    const id = await seedWithTitle("Toolbar pending", "Body");
    let hold = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/notes/${id}/lock**`, async (route) => {
      if (hold && route.request().method() === "GET") await held;
      await route.continue();
    });
    await page.goto(`/vault/${id}`);
    await editableEditor(page);
    // Real history: two edits, one undone, so both undo and redo have work.
    await setEditorSelection(page, at(4));
    await page.keyboard.type(" one");
    await setEditorSelection(page, at(0), at(4));
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.press("ControlOrMeta+z");
    await expectEditorText(page, body("Body one"));
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

    // The page comes back from the background: the lock status loads again.
    hold = true;
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    const content = noteEditor(page);
    await expect(content).toHaveAttribute("aria-readonly", "true");
    await expect(tool(page, "Undo")).toBeDisabled();

    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await setEditorSelection(page, at(0), at(4));
    for (const combo of [
      "ControlOrMeta+z",
      "ControlOrMeta+Shift+z",
      "Control+y",
      "ControlOrMeta+k",
      "ControlOrMeta+Shift+7",
      "ControlOrMeta+Alt+1",
      mac ? "Meta+Alt+f" : "Control+h",
    ]) {
      // ⌘K, unhandled by a read-only editor, opens the quick switcher; Esc closes it.
      await setEditorSelection(page, at(0), at(4));
      await expect(content).toBeFocused();
      await page.keyboard.press(combo);
      await page.keyboard.press("Escape");
      await expect(page.getByPlaceholder("Go to note…")).toBeHidden();
    }
    await page.waitForTimeout(800);
    expect(await editorText(page)).toBe(body("Body one"));

    // Once it has loaded, the same history works again.
    release();
    await expect(content).not.toHaveAttribute("aria-readonly", "true");
    await setEditorSelection(page, 0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expectEditorText(page, body("**Body** one"));
  });
});
