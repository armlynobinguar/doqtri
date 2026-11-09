import { test, expect, type Page } from "@playwright/test";
import { deleteNote, editableEditor, fakeMindmap, readNote, seedNote, uniqueTitle } from "./helpers";

/**
 * A rename renames the note's own title heading too (DOQ-35), so the mindmap
 * keeps folding it into the root (DOQ-30) instead of showing the old title
 * as a lone child. The rewrite is an ordinary save: the open editor adopts
 * it, and its next save goes on without a conflict.
 */

/** What the note's editor shows. The one place that knows which editor it is. */
async function expectEditor(page: Page, text: string) {
  await expect(page.locator("textarea.w-md-editor-text-input")).toHaveValue(text);
}

/** The labels directly under the side panel mindmap's root. */
function topLevelLabels(page: Page) {
  return page.getByTestId("mindmap").locator(":scope > ul > li > span");
}

/** Every `## ` heading of the text, in order: what should ring the root. */
function sections(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

async function rename(page: Page, from: string, to: string) {
  await page.getByRole("button", { name: `Rename ${from}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Note title").fill(to);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByText(`Renamed to “${to}”`)).toBeVisible();
  await expect(dialog).toBeHidden();
}

test.describe("rename keeps the title heading in step (DOQ-35)", () => {
  const notes: string[] = [];
  test.afterAll(async () => {
    for (const id of notes) await deleteNote(id);
  });

  test("a new note renamed shows the new heading and no duplicate mindmap node", async ({ page }) => {
    const conflicts: string[] = [];
    page.on("response", (res) => {
      if (res.status() === 409 && new URL(res.url()).pathname.startsWith("/api/notes/")) conflicts.push(res.url());
    });

    await page.goto("/vault");
    await page.getByRole("button", { name: "New note" }).first().click();
    await page.waitForURL(/\/vault\/[0-9a-f-]{36}$/);
    const id = new URL(page.url()).pathname.split("/")[2];
    notes.push(id);

    const created = await readNote(id);
    expect(created.markdown.startsWith(`# ${created.title}\n`)).toBe(true);
    const expected = sections(created.markdown);
    expect(expected.length).toBeGreaterThan(0);

    await editableEditor(page);
    await page.getByRole("tab", { name: "Mindmap" }).click();
    const mindmap = page.getByTestId("mindmap");
    await expect(mindmap.getByRole("paragraph").first()).toHaveText(created.title);
    await expect(topLevelLabels(page)).toHaveText(expected);

    const renamed = uniqueTitle("Renamed Heading");
    await rename(page, created.title, renamed);

    // The editor shows the new heading at once, the rest untouched.
    const rewritten = created.markdown.replace(`# ${created.title}\n`, `# ${renamed}\n`);
    await expectEditor(page, rewritten);
    await expect.poll(async () => readNote(id)).toEqual({ title: renamed, markdown: rewritten });

    // Sections sit directly around the renamed root: no lone old or new title node.
    await expect(mindmap.getByRole("paragraph").first()).toHaveText(renamed);
    await expect(topLevelLabels(page)).toHaveText(expected);
    await expect(mindmap.getByText(created.title, { exact: true })).toHaveCount(0);

    // The next save goes on from the rename's version.
    const editor = await editableEditor(page);
    await editor.click();
    await editor.press("ControlOrMeta+End");
    await editor.pressSequentially("After the rename.");
    await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await readNote(id)).markdown).toBe(`${rewritten}After the rename.`);
    await expect(page.getByTestId("edit-conflict-banner")).toHaveCount(0);
    expect(conflicts).toEqual([]);

    // The full-screen map is built from the same title and text.
    await page.goto(`/vault/${id}/mindmap`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(renamed);
    await expect(page.getByText("· heading outline")).toBeVisible();
  });

  test("a rename with an edit still unsaved keeps the edit and causes no conflict", async ({ page }) => {
    const conflicts: string[] = [];
    page.on("response", (res) => {
      if (res.status() === 409 && new URL(res.url()).pathname.startsWith("/api/notes/")) conflicts.push(res.url());
    });

    const title = uniqueTitle("Pending Edit");
    const body = "\n\n## Scope\n\nFirst line.";
    const id = await seedNote(title, `# ${title}${body}`);
    notes.push(id);
    await page.goto(`/vault/${id}`);

    const editor = await editableEditor(page);
    await editor.click();
    await editor.press("ControlOrMeta+End");
    // Typed and straight into the dialog, inside the autosave's settle time.
    await editor.pressSequentially(" Typed before the rename.");
    const renamed = uniqueTitle("Pending Renamed");
    await rename(page, title, renamed);

    const expected = `# ${renamed}${body} Typed before the rename.`;
    await expectEditor(page, expected);
    await expect.poll(async () => readNote(id)).toEqual({ title: renamed, markdown: expected });
    await expect(page.getByTestId("edit-conflict-banner")).toHaveCount(0);

    await editor.click();
    await editor.press("ControlOrMeta+End");
    await editor.pressSequentially(" And after it.");
    await expect.poll(async () => (await readNote(id)).markdown, { timeout: 15_000 }).toBe(`${expected} And after it.`);
    await expect(page.getByTestId("edit-conflict-banner")).toHaveCount(0);
    expect(conflicts).toEqual([]);
  });

  test("a stored concept map reads as stale after a heading-changing rename", async ({ page }) => {
    const title = uniqueTitle("Mapped");
    const id = await seedNote(
      title,
      `# ${title}\n\n## Scope\n`,
      fakeMindmap(title, [{ label: "Consensus Design" }, { label: "Fee Market" }]),
    );
    notes.push(id);
    await page.goto(`/vault/${id}`);
    await page.getByRole("tab", { name: "Mindmap" }).click();
    await expect(page.getByText("Concept map", { exact: true })).toBeVisible();

    const renamed = uniqueTitle("Mapped Renamed");
    await rename(page, title, renamed);
    await expect(page.getByText("Note has changed", { exact: true })).toBeVisible();
  });

  test("a rename from another tab is refused while this user edits the note there, and that tab keeps saving", async ({
    page,
    context,
  }) => {
    const conflicts: string[] = [];
    const title = uniqueTitle("Two Tabs");
    const id = await seedNote(title, `# ${title}\n\n## Scope\n\nFirst.`);
    notes.push(id);

    // Tab B edits the note, so it holds the note's edit lock.
    const tabB = await context.newPage();
    tabB.on("response", (res) => {
      if (res.status() === 409 && new URL(res.url()).pathname.startsWith("/api/notes/")) conflicts.push(res.url());
    });
    await tabB.goto(`/vault/${id}`);
    const editorB = await editableEditor(tabB);
    await editorB.click();
    await editorB.press("ControlOrMeta+End");
    await editorB.pressSequentially(" Typed in B.");
    await expect.poll(async () => (await readNote(id)).markdown, { timeout: 15_000 }).toBe(
      `# ${title}\n\n## Scope\n\nFirst. Typed in B.`,
    );

    // Tab A renames it from the explorer, with no editor of its own on it.
    await page.goto("/vault");
    await page.getByRole("button", { name: `Rename ${title}` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note title").fill(uniqueTitle("Two Tabs Renamed"));
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "You are editing this note in another tab or window, so it cannot be renamed here.",
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await readNote(id)).toEqual({ title, markdown: `# ${title}\n\n## Scope\n\nFirst. Typed in B.` });

    // Tab B never noticed: its next save goes on from its own version.
    await editorB.click();
    await editorB.press("ControlOrMeta+End");
    await editorB.pressSequentially(" And more.");
    await expect.poll(async () => (await readNote(id)).markdown, { timeout: 15_000 }).toBe(
      `# ${title}\n\n## Scope\n\nFirst. Typed in B. And more.`,
    );
    await expect(tabB.getByTestId("edit-conflict-banner")).toHaveCount(0);
    expect(conflicts).toEqual([]);
    await tabB.close();
  });

  test("a heading that is not the title is left alone", async ({ page }) => {
    const title = uniqueTitle("Own Heading");
    const markdown = "# Something I wrote\n\n## Scope\n";
    const id = await seedNote(title, markdown);
    notes.push(id);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);

    const renamed = uniqueTitle("Own Renamed");
    await rename(page, title, renamed);
    await expect.poll(async () => readNote(id)).toEqual({ title: renamed, markdown });
    await expectEditor(page, markdown);
  });
});
