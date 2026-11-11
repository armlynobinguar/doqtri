import { test, expect, type Page, type Request } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  editorHasFocus,
  editorSelection,
  editorText,
  expectEditorText,
  readNote,
  seedNote,
  setEditorSelection,
  uniqueTitle,
} from "./helpers";

/*
 * The note's title bar (D-121): `documents.title` is the only place a title
 * lives. The bar renames through the explorer's own rename, so every surface
 * follows at once; the note's text never holds, follows or changes the
 * title, and a `# <title>` line an older note opens with is ordinary text.
 */

const ids: string[] = [];

test.afterEach(async () => {
  while (ids.length) await deleteNote(ids.pop()!);
});

async function seed(title: string, markdown: string): Promise<string> {
  const id = await seedNote(title, markdown);
  ids.push(id);
  return id;
}

function titleBar(page: Page) {
  return page.getByRole("textbox", { name: "Note title" });
}

/** The title bar once the note's lock status has loaded and it can be edited. */
async function editableTitleBar(page: Page) {
  await editableEditor(page);
  const bar = titleBar(page);
  await expect(bar).not.toHaveAttribute("readonly");
  return bar;
}

/** This page's writes to the note: saves (PUT) and renames (PATCH, with their bodies). */
function watchWrites(page: Page, id: string): { method: string; body: string }[] {
  const seen: { method: string; body: string }[] = [];
  page.on("request", (req: Request) => {
    if (new URL(req.url()).pathname !== `/api/notes/${id}`) return;
    if (req.method() === "PUT" || req.method() === "PATCH") seen.push({ method: req.method(), body: req.postData() ?? "" });
  });
  return seen;
}

const renames = (writes: { method: string; body: string }[]) => writes.filter((write) => write.method === "PATCH");

/** The note's title everywhere outside the title bar: the explorer, the tab and both mindmaps. */
async function expectTitleShown(page: Page, title: string, old: string) {
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: old, exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: title, exact: true })).toBeVisible();
  await expect(page.getByTestId("live-mindmap-outline").getByRole("paragraph").first()).toHaveText(title);
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Mindmap" }).click();
  await expect(panel.getByTestId("mindmap").getByRole("paragraph").first()).toHaveText(title);
}

async function renameFromExplorer(page: Page, title: string, next: string) {
  await page.getByRole("button", { name: `Rename ${title}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Note title").fill(next);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe("the note title bar (D-121)", () => {
  test("Enter renames: every surface follows at once, the caret goes to the text, the text is untouched", async ({ page }) => {
    const title = uniqueTitle("Bar Plan");
    // An older note, whose text opens with its title: that line is the note's own now.
    const text = `# ${title}\n\n## Scope\n\nFirst line.\n`;
    const id = await seed(title, text);
    const writes = watchWrites(page, id);
    await page.goto(`/vault/${id}`);

    const bar = await editableTitleBar(page);
    await expect(bar).toHaveValue(title);
    const renamed = uniqueTitle("Bar Roadmap");
    await bar.fill(renamed);
    await bar.press("Enter");

    // Focus moved to the start of the text (before the checks below click anything).
    await expect.poll(() => editorHasFocus(page)).toBe(true);
    expect(await editorSelection(page)).toEqual({ anchor: 0, head: 0 });
    await expectTitleShown(page, renamed, title);
    await expect(bar).toHaveValue(renamed);
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({ title: renamed, markdown: text });

    // One rename, of the title alone, and no save: nothing in the text changed.
    await page.waitForTimeout(1_500);
    expect(renames(writes)).toHaveLength(1);
    expect(JSON.parse(renames(writes)[0].body)).toEqual({ title: renamed });
    expect(writes.filter((write) => write.method === "PUT")).toHaveLength(0);
    expect(await editorText(page)).toBe(text);
  });

  test("leaving the field renames too, and a rename from the explorer shows in the bar at once", async ({ page }) => {
    const title = uniqueTitle("Bar Blur");
    const text = "## Scope\n\nBody.\n";
    const id = await seed(title, text);
    const writes = watchWrites(page, id);
    await page.goto(`/vault/${id}`);

    const bar = await editableTitleBar(page);
    const typed = uniqueTitle("Bar Left");
    await bar.fill(`  ${typed}  `);
    await setEditorSelection(page, -1);
    await expect(bar).toHaveValue(typed);
    await expect.poll(async () => (await readNote(id)).title, { timeout: 15_000 }).toBe(typed);

    const fromExplorer = uniqueTitle("Bar Sidebar");
    await renameFromExplorer(page, typed, fromExplorer);
    await expect(bar).toHaveValue(fromExplorer);
    await expect(page.getByRole("tab", { name: fromExplorer, exact: true })).toBeVisible();
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({ title: fromExplorer, markdown: text });
    expect(writes.filter((write) => write.method === "PUT")).toHaveLength(0);
    expect(await editorText(page)).toBe(text);
  });

  test("a new note, renamed from the explorer, then Backspace on line 1: one title, the text as typed", async ({ page }) => {
    await page.goto("/vault");
    await page.getByRole("button", { name: "New note" }).click();
    await page.waitForURL(/\/vault\/[0-9a-f-]{36}$/);
    const id = new URL(page.url()).pathname.split("/")[2];
    ids.push(id);

    const bar = await editableTitleBar(page);
    await expect(bar).toHaveValue(/^Untitled/);
    const created = await bar.inputValue();
    // New notes start with their body: no `# <title>` line (D-121).
    const text = await editorText(page);
    expect(text.startsWith("## Overview\n")).toBe(true);
    expect(text).not.toMatch(/^# /m);

    const renamed = uniqueTitle("Fresh Plan");
    await renameFromExplorer(page, created, renamed);
    await expect(bar).toHaveValue(renamed);

    // Straight away: the caret at the end of line 1, and Backspace.
    const lineOne = text.indexOf("\n");
    await setEditorSelection(page, lineOne);
    await page.keyboard.press("Backspace");
    const typed = text.slice(0, lineOne - 1) + text.slice(lineOne);
    await expectEditorText(page, typed);
    await expect(bar).toHaveValue(renamed);
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({ title: renamed, markdown: typed });

    await page.reload();
    await expect(await editableTitleBar(page)).toHaveValue(renamed);
    await expectEditorText(page, typed);
    await expect(page.getByRole("link", { name: renamed, exact: true })).toHaveCount(1);
    await expect(page.getByRole("link", { name: created, exact: true })).toHaveCount(0);
  });

  test("a note from a starter template starts with its body, and its title is in the bar", async ({ page }) => {
    await page.goto("/vault/templates");
    await page.getByTestId("template-client-project").click();
    await page.getByTestId("use-template").click();
    await page.waitForURL(/\/vault\/[0-9a-f-]{36}$/);
    const id = new URL(page.url()).pathname.split("/")[2];
    ids.push(id);

    await expect(await editableTitleBar(page)).toHaveValue(/^Client Project/);
    const { title, markdown } = await readNote(id);
    expect(title).toMatch(/^Client Project/);
    expect(markdown.startsWith("Client: ")).toBe(true);
    expect(markdown).not.toMatch(/^# /m);
    expect(await editorText(page)).toBe(markdown);
  });

  test("Escape, a blank field or the same title put the title back and rename nothing", async ({ page }) => {
    const title = uniqueTitle("Bar Keep");
    const id = await seed(title, "Body.\n");
    const writes = watchWrites(page, id);
    await page.goto(`/vault/${id}`);
    const bar = await editableTitleBar(page);

    await bar.fill(uniqueTitle("Bar Never"));
    await bar.press("Escape");
    await expect(bar).toHaveValue(title);
    await expect(bar).toBeFocused();
    await setEditorSelection(page, -1);

    await bar.fill("   ");
    await setEditorSelection(page, -1);
    await expect(bar).toHaveValue(title);

    await bar.fill(` ${title} `);
    await bar.press("Enter");
    await expect(bar).toHaveValue(title);

    await page.waitForTimeout(1_000);
    expect(renames(writes)).toHaveLength(0);
    expect((await readNote(id)).title).toBe(title);
  });

  test("a title another note has is refused with the explorer's message, and the old title stays", async ({ page }) => {
    const title = uniqueTitle("Bar Mine");
    const taken = uniqueTitle("Bar Taken");
    const id = await seed(title, "Body.\n");
    await seed(taken, "Other body.\n");
    const writes = watchWrites(page, id);
    await page.goto(`/vault/${id}`);
    const bar = await editableTitleBar(page);

    await bar.fill(taken.toUpperCase());
    await bar.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Another note is already called" })).toHaveText(
      `Another note is already called “${taken.toUpperCase()}”`,
    );
    await expect(bar).toHaveValue(title);
    await expect(page.getByRole("tab", { name: title, exact: true })).toBeVisible();

    // Typing again clears the message.
    await bar.fill(`${title} 2`);
    await expect(page.getByRole("alert").filter({ hasText: "Another note is already called" })).toHaveCount(0);
    await bar.press("Escape");

    await page.waitForTimeout(1_000);
    expect(renames(writes)).toHaveLength(0);
    expect((await readNote(id)).title).toBe(title);
  });

  test("a second rename while the first is on its way is refused, keeping what was typed, and goes once it has landed", async ({ page }) => {
    const title = uniqueTitle("Bar First");
    const text = "Body.\n";
    const id = await seed(title, text);
    const writes = watchWrites(page, id);
    // Holds the first rename's PATCH until released.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = true;
    await page.route(
      (url) => url.pathname === `/api/notes/${id}`,
      async (route) => {
        if (route.request().method() === "PATCH" && holding) {
          holding = false;
          await held;
        }
        await route.fallback();
      },
    );
    await page.goto(`/vault/${id}`);
    const bar = await editableTitleBar(page);

    const first = uniqueTitle("Bar Second");
    await bar.fill(first);
    await bar.press("Enter");
    await expect(page.getByRole("tab", { name: first, exact: true })).toBeVisible();

    const second = uniqueTitle("Bar Third");
    await bar.click();
    await bar.fill(second);
    await bar.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "still being changed" })).toHaveText(
      `“${first}” is still being changed. Try again in a moment.`,
    );
    await expect(bar).toHaveValue(second);
    await expect(bar).toBeFocused();
    expect(renames(writes)).toHaveLength(1);

    release();
    await expect.poll(async () => (await readNote(id)).title, { timeout: 15_000 }).toBe(first);
    // Settled once the explorer's row offers its rename again.
    await expect(page.getByRole("button", { name: `Rename ${first}`, exact: true })).toBeEnabled({ timeout: 15_000 });
    await expect(bar).toHaveValue(second);
    await bar.press("Enter");
    await expect(page.getByRole("tab", { name: second, exact: true })).toBeVisible();
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({ title: second, markdown: text });
    expect(renames(writes).map((write) => JSON.parse(write.body).title)).toEqual([first, second]);
  });

  test("Escape in the title bar in full screen puts the title back and stays in full screen", async ({ page }) => {
    const title = uniqueTitle("Bar Full");
    const id = await seed(title, "Body.\n");
    await page.goto(`/vault/${id}`);
    const bar = await editableTitleBar(page);
    await page.getByRole("button", { name: "Hide mindmap" }).click();
    await page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Full screen", exact: true }).click();
    const fullscreen = page.getByRole("dialog", { name: "Full screen editor" });
    await expect(fullscreen).toBeVisible();

    await bar.fill(uniqueTitle("Bar Never"));
    await bar.press("Escape");
    await expect(bar).toHaveValue(title);
    await expect(fullscreen).toBeVisible();
    expect((await readNote(id)).title).toBe(title);
  });

  test("a copy that is read-only (the note is being edited in another tab) shows the title but cannot change it", async ({ page }) => {
    const title = uniqueTitle("Bar Locked");
    const id = await seed(title, "Body.\n");
    await page.goto(`/vault/${id}`);
    await editableEditor(page);
    // The first edit takes the lock for this tab.
    await setEditorSelection(page, -1);
    await page.keyboard.type("x");
    await expect.poll(async () => (await readNote(id)).markdown, { timeout: 15_000 }).toBe("Body.\nx");

    const other = await page.context().newPage();
    try {
      await other.goto(`/vault/${id}`);
      await expect(other.getByText("You are editing this note in another tab or window").first()).toBeVisible();
      const bar = titleBar(other);
      await expect(bar).toHaveValue(title);
      await expect(bar).toHaveAttribute("readonly", "");
      await bar.click();
      await other.keyboard.type("Nope");
      await other.keyboard.press("Enter");
      await expect(bar).toHaveValue(title);
      expect((await readNote(id)).title).toBe(title);
    } finally {
      await other.close();
    }
  });
});
