import { test, expect, type Page, type Request } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  editorText,
  expectEditorText,
  readNote,
  replaceEditorText,
  seedNote,
  serviceRest,
  setEditorSelection,
  uniqueTitle,
} from "./helpers";

/**
 * Editing a note's title heading renames the note (DOQ-36): the other half of
 * DOQ-35, so the heading and the title stay one thing and the mindmap keeps
 * folding the heading into its root (DOQ-30). These cases run on the desktop
 * layout (heading-rename.spec.ts) and the phone's (mobile.spec.ts), which
 * show the title and the mindmap in different places: `Layout` says where.
 */
export type Layout = {
  /** The note's title shows where this layout shows it, and the old one nowhere there. */
  expectTitle(page: Page, title: string, old: string): Promise<void>;
  /** The note's mindmap, with `sections` directly around a root named `title`, and no `old` node. */
  expectMindmap(page: Page, title: string, sections: string[], old: string): Promise<void>;
  /** The note's backlinks count, as the right panel shows it. */
  expectBacklinks(page: Page, count: number): Promise<void>;
};

const BODY = "\n\n## Scope\n\nFirst line.";

/** The title renames: PATCH /api/notes/<id>. Saves are PUTs, and the lock has its own path. */
function watchRenames(page: Page, id: string): { at: number; body: string }[] {
  const seen: { at: number; body: string }[] = [];
  page.on("request", (req: Request) => {
    if (req.method() === "PATCH" && new URL(req.url()).pathname === `/api/notes/${id}`) {
      seen.push({ at: Date.now(), body: req.postData() ?? "" });
    }
  });
  return seen;
}

/** Replaces the text of the note's first-line heading, `# <from>`, by typing `to` over it. */
async function retypeHeading(page: Page, from: string, to: string) {
  await editableEditor(page);
  const text = await editorText(page);
  expect(text.startsWith(`# ${from}`)).toBe(true);
  await setEditorSelection(page, 2, 2 + from.length);
  await page.keyboard.type(to);
}

/** Waits until the server holds `markdown`: the edit has settled and saved. */
async function expectSaved(id: string, markdown: string) {
  await expect.poll(async () => (await readNote(id)).markdown, { timeout: 15_000 }).toBe(markdown);
}

/** Moves the caret to the end of the note, off the title line. */
async function caretToEnd(page: Page) {
  await setEditorSelection(page, -1);
}

function notice(page: Page) {
  return page.getByTestId("heading-notice");
}

function noticeStatus(page: Page) {
  return page.getByTestId("heading-notice-status");
}

export function headingRenameCases(layout: Layout) {
  const notes: string[] = [];
  test.afterAll(async () => {
    for (const id of notes) await deleteNote(id);
  });

  async function seed(title: string, markdown: string) {
    const id = await seedNote(title, markdown);
    notes.push(id);
    return id;
  }

  test("editing the title heading and pausing renames the note, live, with one PATCH", async ({ page }) => {
    const title = uniqueTitle("Plan");
    const id = await seed(title, `# ${title}${BODY}`);
    const renames = watchRenames(page, id);
    await page.goto(`/vault/${id}`);
    // A full reload would drop this.
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));

    const renamed = uniqueTitle("Roadmap");
    await retypeHeading(page, title, renamed);
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({
      title: renamed,
      markdown: `# ${renamed}${BODY}`,
    });

    await layout.expectTitle(page, renamed, title);
    await layout.expectMindmap(page, renamed, ["Scope"], title);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    // One settled edit, one rename: no second PATCH once it has landed.
    await page.waitForTimeout(1_500);
    expect(renames).toHaveLength(1);
    expect(JSON.parse(renames[0].body)).toMatchObject({ title: renamed });
    // A title-only rename: the text is the student's, already saved.
    expect(JSON.parse(renames[0].body)).not.toHaveProperty("markdown");
    await expect(notice(page)).toHaveCount(0);
  });

  test("moving the caret off the heading renames without waiting for the pause", async ({ page }) => {
    const title = uniqueTitle("Caret Plan");
    const id = await seed(title, `# ${title}${BODY}`);
    const renames = watchRenames(page, id);
    await page.goto(`/vault/${id}`);

    const renamed = uniqueTitle("Caret Roadmap");
    await retypeHeading(page, title, renamed);
    await caretToEnd(page);
    // Typing on without a pause, so the edit never settles: only the caret
    // leaving the heading can have asked for the rename.
    await page.keyboard.type(" typing on and on", { delay: 150 });
    const typingDone = Date.now();
    expect(renames).toHaveLength(1);
    expect(renames[0].at).toBeLessThan(typingDone);

    await expectSaved(id, `# ${renamed}${BODY} typing on and on`);
    expect((await readNote(id)).title).toBe(renamed);
    await layout.expectTitle(page, renamed, title);
    // The pause that follows asks for nothing more.
    await page.waitForTimeout(1_500);
    expect(renames).toHaveLength(1);
  });

  test("a heading that never said the title is the student's own and never renames", async ({ page }) => {
    const title = uniqueTitle("Own Title");
    const id = await seed(title, `# Something I wrote${BODY}`);
    const renames = watchRenames(page, id);
    await page.goto(`/vault/${id}`);

    await retypeHeading(page, "Something I wrote", "Something else");
    await caretToEnd(page);
    await expectSaved(id, `# Something else${BODY}`);
    await page.waitForTimeout(1_500);
    expect(renames).toHaveLength(0);
    expect((await readNote(id)).title).toBe(title);
  });

  test("deleting or emptying the heading, or making it ## or prose, does not rename; a pasted note does", async ({
    page,
  }) => {
    const title = uniqueTitle("Kept Title");
    const original = `# ${title}${BODY}`;
    const id = await seed(title, original);
    const renames = watchRenames(page, id);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);

    for (const changed of [`# ${BODY}`, `#${BODY}`, BODY.trimStart(), `## ${title} notes${BODY}`, `Some prose.${BODY}`]) {
      await replaceEditorText(page, changed);
      await expectSaved(id, changed);
      await replaceEditorText(page, original);
      await expectSaved(id, original);
    }
    await page.waitForTimeout(1_000);
    expect(renames).toHaveLength(0);
    expect((await readNote(id)).title).toBe(title);

    // Pasting over the whole note: the same rule, on its new first line.
    const pasted = uniqueTitle("Pasted Note");
    await replaceEditorText(page, `# ${pasted}\n\nAll new.`);
    await expect.poll(async () => (await readNote(id)).title, { timeout: 15_000 }).toBe(pasted);
    expect(renames).toHaveLength(1);
  });

  test("a clashing heading warns at the heading, keeps the text and the title, and clears when resolved", async ({
    page,
  }) => {
    const taken = uniqueTitle("Taken Title");
    await seed(taken, `# ${taken}\n`);
    const title = uniqueTitle("Clash Plan");
    const id = await seed(title, `# ${title}${BODY}`);
    const renames = watchRenames(page, id);
    await page.goto(`/vault/${id}`);

    await retypeHeading(page, title, taken);
    const warning = `Another note is already called “${taken}”. The title stays “${title}”. Edit the heading, or rename the note from the explorer.`;
    await expect(notice(page)).toHaveText(warning, { timeout: 15_000 });
    await expect(notice(page)).toHaveCount(1);
    // Announced politely, from a region that is always there.
    await expect(noticeStatus(page)).toHaveAttribute("aria-live", "polite");
    await expect(noticeStatus(page)).toHaveText(warning);
    // The text keeps the student's heading; the title stays.
    await expectSaved(id, `# ${taken}${BODY}`);
    expect((await readNote(id)).title).toBe(title);
    await expectEditorText(page, `# ${taken}${BODY}`);
    expect(renames).toHaveLength(1);

    // More edits while it stands do not ask again: one warning, no repeats.
    await caretToEnd(page);
    await page.keyboard.type(" More.");
    await expectSaved(id, `# ${taken}${BODY} More.`);
    await page.waitForTimeout(1_000);
    expect(renames).toHaveLength(1);
    await expect(notice(page)).toHaveCount(1);

    // Back to the current title: the warning clears, nothing to rename.
    await retypeHeading(page, taken, title);
    await expect(notice(page)).toHaveCount(0);
    await expect(noticeStatus(page)).toHaveText("");
    await expectSaved(id, `# ${title}${BODY} More.`);
    expect(renames).toHaveLength(1);

    // Clashing again warns again; a free title then renames and clears it.
    await retypeHeading(page, title, taken);
    await expect(notice(page)).toHaveText(warning, { timeout: 15_000 });
    const free = uniqueTitle("Free Title");
    await retypeHeading(page, taken, free);
    await expect.poll(async () => (await readNote(id)).title, { timeout: 15_000 }).toBe(free);
    await expect(notice(page)).toHaveCount(0);
    await layout.expectTitle(page, free, title);
    expect(renames).toHaveLength(3);
  });

  test("with backlinks, the rename says how many notes still link to the old title, until dismissed", async ({
    page,
  }) => {
    const title = uniqueTitle("Linked Plan");
    const id = await seed(title, `# ${title}${BODY}`);
    await seed(uniqueTitle("Links One"), `# Links One\n\nSee [[${title}]].\n`);
    await seed(uniqueTitle("Links Two"), `# Links Two\n\nAlso [[${title}]] here.\n`);
    await page.goto(`/vault/${id}`);
    await layout.expectBacklinks(page, 2);

    const renamed = uniqueTitle("Linked Roadmap");
    await retypeHeading(page, title, renamed);
    const message = `Renamed to “${renamed}”. 2 notes still link to “${title}”.`;
    await expect(notice(page)).toHaveText(message, { timeout: 15_000 });
    await expect(noticeStatus(page)).toHaveText(message);
    expect((await readNote(id)).title).toBe(renamed);
    // Their links are not rewritten, so they no longer reach this note: the
    // graph's data, which the backlinks are built from, has the new title.
    await layout.expectBacklinks(page, 0);

    await notice(page).getByRole("button", { name: "Dismiss" }).click();
    await expect(notice(page)).toHaveCount(0);
    await expect(noticeStatus(page)).toHaveText("");
  });

  test("undoing the heading edit renames the note back", async ({ page }) => {
    const title = uniqueTitle("Undo Plan");
    const id = await seed(title, `# ${title}${BODY}`);
    const renames = watchRenames(page, id);
    await page.goto(`/vault/${id}`);

    const renamed = uniqueTitle("Undo Roadmap");
    await retypeHeading(page, title, renamed);
    await expect.poll(async () => (await readNote(id)).title, { timeout: 15_000 }).toBe(renamed);
    await layout.expectTitle(page, renamed, title);

    await caretToEnd(page);
    await page.keyboard.press("ControlOrMeta+z");
    await expectEditorText(page, `# ${title}${BODY}`);
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({
      title,
      markdown: `# ${title}${BODY}`,
    });
    await layout.expectTitle(page, title, renamed);
    expect(renames).toHaveLength(2);
  });

  test("a copy that is read-only, or whose lock is still loading, never renames", async ({ page, context }) => {
    test.setTimeout(120_000);
    const title = uniqueTitle("Locked Plan");
    const id = await seed(title, `# ${title}${BODY}`);

    // Another tab of this user edits the note, so it holds the edit lock.
    const holder = await context.newPage();
    await holder.goto(`/vault/${id}`);
    await editableEditor(holder);
    await setEditorSelection(holder, -1);
    await holder.keyboard.type(" Held.");
    await expectSaved(id, `# ${title}${BODY} Held.`);

    const renames = [page, holder].map((tab) => watchRenames(tab, id));
    const total = () => renames.reduce((sum, list) => sum + list.length, 0);

    // This tab opens it with the lock's status held back: pending, then read-only.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/notes/${id}/lock?**`, async (route) => {
      if (route.request().method() === "GET") await held;
      await route.continue();
    });
    await page.goto(`/vault/${id}`);
    await expect(page.getByTestId("note-editor").locator(".cm-content")).toBeVisible();
    await setEditorSelection(page, 2, 2 + title.length);
    await page.keyboard.type("Pending Heading");
    await caretToEnd(page);
    await expectEditorText(page, `# ${title}${BODY} Held.`);
    release();

    // The lock is the other tab's: only the existing banner says so.
    await expect(page.getByText("You are editing this note in another tab or window")).toBeVisible();
    await setEditorSelection(page, 2, 2 + title.length);
    await page.keyboard.type("Read Only Heading");
    await caretToEnd(page);
    await expectEditorText(page, `# ${title}${BODY} Held.`);

    // A heading changed from outside reaches the read-only copy; it renames nothing there.
    const outside = uniqueTitle("Outside Heading");
    await serviceRest(`documents?id=eq.${id}`, {
      method: "PATCH",
      body: { markdown: `# ${outside}${BODY} Held.` },
    });
    await expectEditorText(page, `# ${outside}${BODY} Held.`, 30_000);
    await page.waitForTimeout(2_000);

    expect(total()).toBe(0);
    expect((await readNote(id)).title).toBe(title);
    await expect(notice(page)).toHaveCount(0);
    await holder.close();
  });
}
