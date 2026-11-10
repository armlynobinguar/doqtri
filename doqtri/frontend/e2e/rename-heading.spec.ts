import { test, expect, type Page } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  expectEditorText,
  fakeMindmap,
  readNote,
  seedNote,
  setEditorSelection,
  uniqueTitle,
} from "./helpers";

/**
 * A rename renames the note's own title heading too (DOQ-35), so the mindmap
 * keeps folding it into the root (DOQ-30) instead of showing the old title
 * as a lone child. The rewrite is an ordinary save: the open editor adopts
 * it, and its next save goes on without a conflict.
 *
 * A note whose first line is not the title heading keeps its text through a
 * rename; since D-120 the editor shows the new title above it, and writes
 * that title line with the note's first edit.
 */

/** The side panel, which holds the Mindmap tab; the live mindmap pane beside the editor is apart from it. */
function rightPanel(page: Page) {
  return page.getByTestId("right-panel");
}

/** The side panel's mindmap. */
function sideMindmap(page: Page) {
  return rightPanel(page).getByTestId("mindmap");
}

/** The labels directly under the side panel mindmap's root. */
function topLevelLabels(page: Page) {
  return sideMindmap(page).locator(":scope > ul > li > span");
}

/** Types `text` at the end of the note, as the user would. */
async function typeAtEnd(page: Page, text: string) {
  await editableEditor(page);
  await setEditorSelection(page, -1);
  await page.keyboard.type(text);
}

/** Every `## ` heading of the text, in order: what should ring the root. */
function sections(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

/**
 * Renames from the explorer and waits for the rename to settle. The dialog
 * closes at once and the new title shows before the server answers (DOQ-32);
 * the row's Rename button stays disabled until it has.
 */
async function rename(page: Page, from: string, to: string) {
  await page.getByRole("button", { name: `Rename ${from}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Note title").fill(to);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: `Rename ${to}`, exact: true })).toBeEnabled({ timeout: 15_000 });
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
    await rightPanel(page).getByRole("tab", { name: "Mindmap" }).click();
    const mindmap = sideMindmap(page);
    const liveOutline = page.getByTestId("live-mindmap-outline");
    await expect(mindmap.getByRole("paragraph").first()).toHaveText(created.title);
    await expect(topLevelLabels(page)).toHaveText(expected);

    const renamed = uniqueTitle("Renamed Heading");
    await rename(page, created.title, renamed);

    // The editor shows the new heading at once, the rest untouched.
    const rewritten = created.markdown.replace(`# ${created.title}\n`, `# ${renamed}\n`);
    await expectEditorText(page, rewritten);
    await expect.poll(async () => readNote(id)).toEqual({ title: renamed, markdown: rewritten });

    // Sections sit directly around the renamed root: no lone old or new title
    // node, in the side panel or the live mindmap beside the editor.
    await expect(mindmap.getByRole("paragraph").first()).toHaveText(renamed);
    await expect(topLevelLabels(page)).toHaveText(expected);
    await expect(mindmap.getByText(created.title, { exact: true })).toHaveCount(0);
    await expect(liveOutline.getByRole("paragraph")).toHaveText(renamed);
    await expect(liveOutline.getByText(created.title, { exact: true })).toHaveCount(0);

    // The next save goes on from the rename's version.
    await typeAtEnd(page, "After the rename.");
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

    // Typed and straight into the dialog, inside the autosave's settle time.
    await typeAtEnd(page, " Typed before the rename.");
    const renamed = uniqueTitle("Pending Renamed");
    await rename(page, title, renamed);

    const expected = `# ${renamed}${body} Typed before the rename.`;
    await expectEditorText(page, expected);
    await expect.poll(async () => readNote(id)).toEqual({ title: renamed, markdown: expected });
    await expect(page.getByTestId("edit-conflict-banner")).toHaveCount(0);

    await typeAtEnd(page, " And after it.");
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
    // The live mindmap pane has a "Concept map" tab of its own: read the side panel's label.
    await rightPanel(page).getByRole("tab", { name: "Mindmap" }).click();
    await expect(rightPanel(page).getByText("Concept map", { exact: true })).toBeVisible();

    const renamed = uniqueTitle("Mapped Renamed");
    await rename(page, title, renamed);
    await expect(rightPanel(page).getByText("Note has changed", { exact: true })).toBeVisible();
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
    await typeAtEnd(tabB, " Typed in B.");
    await expect.poll(async () => (await readNote(id)).markdown, { timeout: 15_000 }).toBe(
      `# ${title}\n\n## Scope\n\nFirst. Typed in B.`,
    );

    // Tab A renames it from the explorer, with no editor of its own on it.
    // The dialog has closed by the time the server refuses, so the refusal
    // is a toast, and the old title comes back (DOQ-32).
    await page.bringToFront();
    await page.goto("/vault");
    await page.getByRole("button", { name: `Rename ${title}` }).click();
    const dialog = page.getByRole("dialog");
    const attempted = uniqueTitle("Two Tabs Renamed");
    await dialog.getByLabel("Note title").fill(attempted);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText("You are editing this note in another tab or window, so it cannot be renamed here."),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: title, exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: attempted })).toHaveCount(0);
    expect(await readNote(id)).toEqual({ title, markdown: `# ${title}\n\n## Scope\n\nFirst. Typed in B.` });

    // Tab B never noticed: its next save goes on from its own version.
    await tabB.bringToFront();
    await typeAtEnd(tabB, " And more.");
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
    await expectEditorText(page, markdown);
  });

  test("a never-opened note that does not open with its title keeps its text through a rename, and gets the new title line with its first edit", async ({
    page,
  }) => {
    const title = uniqueTitle("Never Opened");
    const markdown = "Some prose first.\n\n## Scope\n";
    const id = await seedNote(title, markdown);
    notes.push(id);

    // Renamed from the explorer without opening it: the server changes the title alone.
    await page.goto("/vault");
    const renamed = uniqueTitle("Never Opened Renamed");
    await rename(page, title, renamed);
    await expect.poll(async () => readNote(id)).toEqual({ title: renamed, markdown });

    // Opened, it shows the new title above the text and writes nothing...
    await page.goto(`/vault/${id}`);
    await editableEditor(page);
    await expect(page.getByTestId("title-line-preview")).toHaveText(renamed);
    await page.waitForTimeout(1_000);
    expect(await readNote(id)).toEqual({ title: renamed, markdown });

    // ...and after its first edit, the new title line goes above it.
    await setEditorSelection(page, -1);
    await page.keyboard.type("More.");
    const expected = `# ${renamed}\n\n${markdown}More.`;
    await expectEditorText(page, expected, 20_000);
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({ title: renamed, markdown: expected });
    // The mindmap folds it into the root: Scope rings it, no lone title node.
    await rightPanel(page).getByRole("tab", { name: "Mindmap" }).click();
    await expect(sideMindmap(page).getByRole("paragraph").first()).toHaveText(renamed);
    await expect(topLevelLabels(page)).toHaveText(["Scope"]);
  });
});
