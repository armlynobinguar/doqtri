import { test, expect, type Page } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  editorLine,
  editorSelection,
  editorText,
  noteEditor,
  placeCaretAfter,
  readNote,
  seedNote,
  setEditorSelection,
  uniqueTitle,
} from "./helpers";

/*
 * The live-preview editor (DOQ-31): one column of markdown that reads as
 * rendered text, with the raw source shown only on the lines the caret or
 * selection touches. Tables and images render as widgets; the saved note is
 * still exactly the markdown that was typed.
 */

const ids: string[] = [];

async function openNote(page: Page, markdown: string): Promise<string> {
  const id = await seedNote(uniqueTitle("Live preview"), markdown);
  ids.push(id);
  await page.goto(`/vault/${id}`);
  await editableEditor(page);
  return id;
}

test.afterEach(async () => {
  while (ids.length) await deleteNote(ids.pop()!);
});

/** A 1×1 PNG, so image tests never depend on the internet. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const IMAGE_HOST = "https://images.e2e.invalid";

test.describe("live preview", () => {
  test("a heading shows its source only while the caret is on it", async ({ page }) => {
    await openNote(page, "# Title\n\nIntro text.");
    await placeCaretAfter(page, "Intro text.");
    await page.keyboard.type("\n## Goals");

    await expect(editorLine(page, "Goals")).toHaveText("## Goals");
    await page.keyboard.press("ArrowUp");
    // Off the line: the hashes are hidden and the line is a sized heading.
    await expect(editorLine(page, "Goals")).toHaveText("Goals");
    await expect(editorLine(page, "Goals")).toHaveClass(/cm-lp-h2/);
    await expect.poll(() => editorText(page)).toBe("# Title\n\nIntro text.\n## Goals");
  });

  test("inline and block syntax hides everywhere but the caret's line", async ({ page }) => {
    await openNote(
      page,
      [
        "Some **bold**, _italic_, ~~gone~~, `code`, a [link](https://example.com) and [[Other note]].",
        "",
        "- a bullet",
        "1. a number",
        "",
        "> quoted",
        "",
        "---",
        "",
        "```js",
        "const a = 1;",
        "```",
        "",
        "end",
      ].join("\n"),
    );
    await setEditorSelection(page, -1);

    await expect(editorLine(page, "Some")).toHaveText("Some bold, italic, gone, code, a link and Other note.");
    await expect(editorLine(page, "a bullet")).toHaveText("• a bullet");
    await expect(editorLine(page, "a number")).toHaveText("1. a number");
    await expect(editorLine(page, "quoted")).toHaveText("quoted");
    await expect(noteEditor(page).locator(".cm-lp-hr")).toHaveCount(1);
    await expect(editorLine(page, "const a")).toHaveClass(/cm-lp-fence/);
    await expect(noteEditor(page).getByText("```")).toHaveCount(0);

    // On the line: every character of the source is back.
    await placeCaretAfter(page, "Some");
    await expect(editorLine(page, "Some")).toHaveText(
      "Some **bold**, _italic_, ~~gone~~, `code`, a [link](https://example.com) and [[Other note]].",
    );
    await placeCaretAfter(page, "quot");
    await expect(editorLine(page, "quoted")).toHaveText("> quoted");
    await placeCaretAfter(page, "--");
    await expect(editorLine(page, "---")).toHaveText("---");
    await placeCaretAfter(page, "```j");
    await expect(editorLine(page, "```js")).toHaveText("```js");
  });

  test("a selection over several lines shows all of them as source", async ({ page }) => {
    await openNote(page, "## One\n\n**two**\n\n## Three\n\nfour");
    const text = await editorText(page);
    await setEditorSelection(page, text.indexOf("One"), text.indexOf("Three") + 2);
    await expect(editorLine(page, "One")).toHaveText("## One");
    await expect(editorLine(page, "two")).toHaveText("**two**");
    await expect(editorLine(page, "Three")).toHaveText("## Three");
    await expect(editorLine(page, "four")).toHaveText("four");
  });

  test("a table renders as a grid and shows its source whole when touched", async ({ page }) => {
    await openNote(
      page,
      ["Above.", "", "| Name | **Score** | Note |", "| :--- | ---: | :-: |", "| Ada | 10 | `x` |", "| Bob | 7 | [[Other]] |", "", "Below."].join(
        "\n",
      ),
    );
    await setEditorSelection(page, 0);
    const grid = noteEditor(page).locator("table.cm-lp-table");
    await expect(grid).toBeVisible();
    await expect(grid.locator("th")).toHaveText(["Name", "Score", "Note"]);
    await expect(grid.locator("th strong")).toHaveText("Score");
    await expect(grid.locator("td code")).toHaveText("x");
    await expect(grid.locator("tbody tr").first().locator("td").nth(1)).toHaveCSS("text-align", "right");
    await expect(grid.locator("tbody tr").first().locator("td").nth(2)).toHaveCSS("text-align", "center");

    // The caret on any one row shows every row as source.
    await placeCaretAfter(page, "| Bob");
    await expect(grid).toHaveCount(0);
    await expect(editorLine(page, "| Name")).toHaveText("| Name | **Score** | Note |");
    await expect(editorLine(page, ":---")).toBeVisible();

    await setEditorSelection(page, 0);
    await expect(grid).toBeVisible();

    // A click on a cell opens the table with the caret in that cell's text.
    await grid.getByRole("cell", { name: "Ada" }).click();
    await expect(grid).toHaveCount(0);
    const text = await editorText(page);
    const ada = text.indexOf("Ada");
    const { head } = await editorSelection(page);
    expect(head).toBeGreaterThanOrEqual(ada);
    expect(head).toBeLessThanOrEqual(ada + 3);

    await placeCaretAfter(page, "Below");
    await expect(grid).toBeVisible();
  });

  test("a wide table scrolls inside itself, never the page", async ({ page }) => {
    const columns = Array.from({ length: 14 }, (_, i) => `Column number ${i + 1}`);
    await openNote(
      page,
      [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, `| ${columns.map((c) => `${c} value`).join(" | ")} |`, "", "after"].join(
        "\n",
      ),
    );
    await setEditorSelection(page, -1);
    const wrap = noteEditor(page).locator(".cm-lp-table-wrap");
    await expect(wrap).toBeVisible();
    const sizes = await wrap.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    const page_ = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      scroller: (() => {
        const s = document.querySelector<HTMLElement>("[data-testid=note-editor] .cm-scroller")!;
        return s.scrollWidth - s.clientWidth;
      })(),
    }));
    expect(page_.doc).toBeLessThanOrEqual(page_.viewport);
    expect(page_.scroller).toBeLessThanOrEqual(1);
  });

  test("an https image renders off its line, without a referrer", async ({ page }) => {
    const referrers: (string | undefined)[] = [];
    const other: string[] = [];
    await page.route(`${IMAGE_HOST}/**`, async (route) => {
      referrers.push(route.request().headers()["referer"]);
      if (route.request().url().endsWith("/missing.png")) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
    });
    page.on("request", (request) => {
      const url = request.url();
      if (url.endsWith("/relative.png") || url.startsWith("javascript:") || url.startsWith("data:")) other.push(url);
    });

    await openNote(
      page,
      [
        "Pictures.",
        "",
        `![A pixel](${IMAGE_HOST}/pixel.png)`,
        "",
        "![Relative](/relative.png)",
        "",
        "![Script](javascript:alert(1))",
        "",
        `![Gone](${IMAGE_HOST}/missing.png)`,
        "",
        "End.",
      ].join("\n"),
    );
    await setEditorSelection(page, 0);

    const images = noteEditor(page).locator(".cm-lp-image img");
    await expect(images).toHaveCount(1);
    await expect(images.first()).toHaveAttribute("src", `${IMAGE_HOST}/pixel.png`);
    await expect(images.first()).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(images.first()).toHaveAttribute("loading", "lazy");
    await expect(images.first()).toHaveAttribute("alt", "A pixel");
    await expect.poll(() => images.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);

    // Anything but http(s) stays source and is never requested.
    await expect(editorLine(page, "Relative")).toHaveText("![Relative](/relative.png)");
    await expect(editorLine(page, "Script")).toHaveText("![Script](javascript:alert(1))");

    // A broken address shows its alt text and says so, instead of a gap.
    const broken = noteEditor(page).locator(".cm-lp-image-broken");
    await expect(broken).toContainText("Gone");
    await expect(broken).toContainText("could not load");

    // The caret on the image's line shows its source.
    await placeCaretAfter(page, "![A pix");
    await expect(editorLine(page, "A pixel")).toHaveText(`![A pixel](${IMAGE_HOST}/pixel.png)`);
    await expect(images).toHaveCount(0);

    expect(referrers.length).toBeGreaterThan(0);
    expect(referrers.every((referrer) => referrer === undefined)).toBe(true);
    expect(other).toEqual([]);
  });

  test("an image loading does not move the text below it", async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`${IMAGE_HOST}/**`, async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
    });
    await openNote(page, `Top.\n\n![Slow](${IMAGE_HOST}/slow.png)\n\nThe line below.`);
    await setEditorSelection(page, 0);
    const below = editorLine(page, "The line below.");
    await expect(below).toBeVisible();
    await expect(noteEditor(page).locator(".cm-lp-image")).toHaveAttribute("data-state", "loading");
    const before = (await below.boundingBox())!.y;

    release();
    await expect(noteEditor(page).locator(".cm-lp-image")).toHaveAttribute("data-state", "loaded");
    expect((await below.boundingBox())!.y).toBe(before);
  });

  test("the saved note is exactly the markdown typed, table and image included", async ({ page }) => {
    await page.route(`${IMAGE_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
    const id = await openNote(page, "# Typed\n");
    await setEditorSelection(page, -1);
    const typed = `\n| a | b |\n| :- | -: |\n| **1** | [[Two]] |\n\n![cat](${IMAGE_HOST}/cat.png "Cat")\n\nDone _now_.`;
    await page.keyboard.type(typed);

    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await readNote(id)).markdown).toBe(`# Typed\n${typed}`);
    expect(await editorText(page)).toBe(`# Typed\n${typed}`);
  });

  test("the toolbar formats the selection and the shortcuts do too", async ({ page }) => {
    await openNote(page, "word");
    const text = await editorText(page);
    await setEditorSelection(page, 0, text.length);
    await page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Bold" }).click();
    await expect.poll(() => editorText(page)).toBe("**word**");
    await page.keyboard.press("ControlOrMeta+b");
    await expect.poll(() => editorText(page)).toBe("word");
    await page.keyboard.press("ControlOrMeta+i");
    await expect.poll(() => editorText(page)).toBe("*word*");
    await page.keyboard.press("ControlOrMeta+i");
    await page.keyboard.press("ControlOrMeta+k");
    await expect.poll(() => editorText(page)).toBe("[word](url)");
    // ⌘K in the editor inserted a link; it did not open the quick switcher.
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a copy that cannot edit renders everything and takes no edits of any kind", async ({ page, context }) => {
    await page.route(`${IMAGE_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
    const id = await openNote(
      page,
      `# Shared\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![p](${IMAGE_HOST}/p.png)\n\n- [ ] todo\n\nsee `,
    );
    // The first edit takes the lock for this tab.
    await setEditorSelection(page, -1);
    await page.keyboard.type("Mine.");
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
    const held = await editorText(page);

    const other = await context.newPage();
    await other.route(`${IMAGE_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
    const saves: string[] = [];
    other.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname.startsWith("/api/notes/")) saves.push(request.url());
    });
    await other.goto(`/vault/${id}`);
    const content = noteEditor(other);
    await expect(content).toBeVisible();
    await expect(content).toHaveAttribute("contenteditable", "false");
    await expect(other.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);
    await expect(content.locator("table.cm-lp-table")).toBeVisible();
    await expect(content.locator(".cm-lp-image img")).toHaveCount(1);
    // Clicking a rendered table in a read-only copy does not reveal it.
    await content.locator("table.cm-lp-table").click();
    await expect(content.locator("table.cm-lp-table")).toBeVisible();
    await expect(other.getByRole("button", { name: "Regenerate" })).toBeDisabled();

    // Every way of editing: typing, a paste, a link completion, a checkbox.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await editorLine(other, "see").click();
    await other.keyboard.type("typed");
    await other.evaluate(() => navigator.clipboard.writeText("pasted"));
    await other.keyboard.press("ControlOrMeta+v");
    await other.keyboard.type("[[Sha");
    await other.keyboard.press("Enter");
    await content.locator(".cm-lp-task").click();
    await other.waitForTimeout(1_500);
    expect(await editorText(other)).toBe(held);
    expect(saves).toEqual([]);
    await other.close();
  });

  test("a task's checkbox toggles it once the note has loaded", async ({ page }) => {
    const id = await openNote(page, "- [ ] todo\n- [x] done\n\nend");
    await setEditorSelection(page, -1);
    const boxes = noteEditor(page).locator(".cm-lp-task");
    await expect(boxes).toHaveCount(2);
    await boxes.first().click();
    await expect.poll(() => editorText(page)).toBe("- [x] todo\n- [x] done\n\nend");
    await boxes.nth(1).click();
    await expect.poll(() => editorText(page)).toBe("- [x] todo\n- [ ] done\n\nend");
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await readNote(id)).markdown).toBe("- [x] todo\n- [ ] done\n\nend");
  });

  test("syntax broken over lines renders without breaking the editor", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const source = [
      '[a](/uri\n"title")',
      `![alt\ntext](${IMAGE_HOST}/a.png)`,
      `![a](${IMAGE_HOST}/a.png\n"t")`,
      "-\n  [ ] task",
      "end",
    ].join("\n\n");
    await openNote(page, source);
    // Rendered (caret elsewhere), then each line raw in turn, then typing.
    await setEditorSelection(page, -1);
    await expect(editorLine(page, "end")).toBeVisible();
    for (let at = 0; at < source.length; at += 7) await setEditorSelection(page, at);
    await setEditorSelection(page, -1);
    await page.keyboard.type(" still works");
    await expect.poll(() => editorText(page)).toBe(`${source} still works`);
    expect(errors).toEqual([]);
  });
});
