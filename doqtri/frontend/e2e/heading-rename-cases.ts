import { randomUUID } from "node:crypto";
import { test, expect, type Page, type Request } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  editorSelection,
  editorText,
  expectEditorText,
  noteEditor,
  readNote,
  replaceEditorText,
  seedNote,
  serviceRest,
  setEditorSelection,
  testUserId,
  uniqueTitle,
} from "./helpers";

/**
 * Editing a note's title heading renames the note (DOQ-36): the other half of
 * DOQ-35, so the heading and the title stay one thing and the mindmap keeps
 * folding the heading into its root (DOQ-30). These cases run on the desktop
 * layout (heading-rename.spec.ts) and the phone's (mobile.spec.ts), which
 * show the title and the mindmap in different places: `Layout` says where.
 *
 * Since D-120 the first line is the note's title line: the editor keeps its
 * `# ` and never merges or splits it. A note that opens with something else
 * shows its title above the text, writes nothing when opened, and gets
 * `# <title>` with its first edit, unless its headings are linked or
 * anchored.
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

/**
 * This page's writes to the note: saves (PUT), renames (PATCH) and takes of
 * its edit lock (POST to its lock), in order.
 */
function watchWrites(page: Page, id: string): string[] {
  const seen: string[] = [];
  page.on("request", (req: Request) => {
    const path = new URL(req.url()).pathname;
    if (path === `/api/notes/${id}` && (req.method() === "PUT" || req.method() === "PATCH")) seen.push(req.method());
    if (path === `/api/notes/${id}/lock` && req.method() === "POST") seen.push("lock");
  });
  return seen;
}

/** Replaces the text of the note's first-line heading, `# <from>`, by typing `to` over it. */
async function retypeHeading(page: Page, from: string, to: string) {
  await editableEditor(page);
  const text = await editorText(page);
  const at = text.indexOf(`# ${from}`);
  expect(at >= 0 && text.slice(0, at).trim() === "", `the note opens with "# ${from}"`).toBe(true);
  await setEditorSelection(page, at + 2, at + 2 + from.length);
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

  test("a heading that never said the title is the student's own: it never renames, and the title line goes above it", async ({
    page,
  }) => {
    const title = uniqueTitle("Own Title");
    const id = await seed(title, `# Something I wrote${BODY}`);
    const renames = watchRenames(page, id);
    const writes = watchWrites(page, id);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);
    // Opened: the title shows above the student's heading, and nothing is written.
    await expect(page.getByTestId("title-line-preview")).toHaveText(title);
    await page.waitForTimeout(1_500);
    expect(writes).toEqual([]);

    await retypeHeading(page, "Something I wrote", "Something else");
    await caretToEnd(page);
    // The first edit brought the title line above it; the heading is content.
    await expectSaved(id, `# ${title}\n\n# Something else${BODY}`);
    await page.waitForTimeout(1_500);
    expect(renames).toHaveLength(0);
    expect((await readNote(id)).title).toBe(title);
  });

  test("opening an older note writes nothing and takes no lock; its first edit adds the title line, saved with it", async ({
    page,
  }) => {
    for (const legacy of [`Some prose.${BODY}`, BODY]) {
      const title = uniqueTitle("Prose Plan");
      const id = await seed(title, legacy);
      const writes = watchWrites(page, id);
      await page.goto(`/vault/${id}`);
      await editableEditor(page);
      // The title it will get shows above the text, display only.
      await expect(page.getByTestId("title-line-preview")).toHaveText(title);
      await page.waitForTimeout(1_500);
      expect(writes).toEqual([]);
      expect(await readNote(id)).toEqual({ title, markdown: legacy });

      // The first edit: typed where the caret is; once a fresh check allows
      // it, the title line goes above, as its own change.
      await setEditorSelection(page, -1);
      await page.keyboard.type(" More.");
      const withTitle = legacy.startsWith("\n") ? `# ${title}\n${legacy} More.` : `# ${title}\n\n${legacy} More.`;
      await expectEditorText(page, withTitle, 20_000);
      await expectSaved(id, withTitle);
      await expect(page.locator("[data-title-line]")).toHaveAttribute("data-title-line", "added");
      await expect(page.getByTestId("title-line-preview")).toHaveCount(0);
      // Saved as edits are, and the lock taken by the edit; no rename.
      expect(writes).toContain("PUT");
      expect(writes).toContain("lock");
      expect(writes).not.toContain("PATCH");

      // Undo takes the edit back and leaves the title line: saved, then quiet.
      await page.keyboard.press("ControlOrMeta+z");
      const undone = withTitle.slice(0, -" More.".length);
      await expectEditorText(page, undone);
      await expectSaved(id, undone);
      const saves = writes.filter((write) => write === "PUT").length;
      await page.waitForTimeout(2_000);
      expect(writes.filter((write) => write === "PUT")).toHaveLength(saves);
      expect(await readNote(id)).toEqual({ title, markdown: undone });
    }
  });

  test("a note whose heading is linked never gets the title line: its heading ids stay, and the preview shows", async ({
    page,
  }) => {
    const title = uniqueTitle("Linked Heading");
    const legacy = `Intro.${BODY}`;
    const id = await seed(title, legacy);
    // A GitHub link on the note's first heading, h0 ("Scope"): any node link blocks the line.
    await serviceRest("node_links", {
      method: "POST",
      body: { user_id: await testUserId(), document_id: id, node_id: "h0", node_label: "Scope", repo: "e2e/title-line", number: 1 },
      prefer: "return=minimal",
    });
    await page.goto(`/vault/${id}`);
    await editableEditor(page);
    await expect(page.getByTestId("title-line-preview")).toHaveText(title);

    await setEditorSelection(page, -1);
    await page.keyboard.type(" Edited.");
    // The fresh check after the edit finds the link.
    await expect(page.locator("[data-title-line]")).toHaveAttribute("data-title-line", "blocked", { timeout: 20_000 });
    await expectSaved(id, `${legacy} Edited.`);
    await expectEditorText(page, `${legacy} Edited.`);
    await expect(page.getByTestId("title-line-preview")).toHaveText(title);
    // The link still names the heading it was made on.
    const links = await serviceRest<{ node_id: string; node_label: string }[]>(
      `node_links?document_id=eq.${id}&select=node_id,node_label`,
    );
    expect(links).toEqual([{ node_id: "h0", node_label: "Scope" }]);
  });

  test("a copy that is read-only, in Reading view or waiting for its lock shows the title line and writes nothing", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const title = uniqueTitle("Shown Plan");
    const legacy = `Some prose.${BODY}`;
    const id = await seed(title, legacy);
    const writes = watchWrites(page, id);
    const preview = page.getByTestId("title-line-preview");

    // Another tab of this user holds the lock (taken here through the API): read-only.
    const session = randomUUID();
    expect((await page.request.post(`/api/notes/${id}/lock?session=${session}`)).ok()).toBe(true);
    await page.goto(`/vault/${id}`);
    await expect(page.getByText("You are editing this note in another tab or window")).toBeVisible();
    await expect(preview).toHaveText(title);
    await page.waitForTimeout(1_500);
    await expectEditorText(page, legacy);

    // The lock free but Reading view chosen: nothing is written either.
    expect((await page.request.delete(`/api/notes/${id}/lock?session=${session}`)).ok()).toBe(true);
    writes.length = 0;
    await page.evaluate(() => window.localStorage.setItem("doqtri:editor-view", "reading"));
    await page.reload();
    await expect(noteEditor(page)).toHaveAttribute("contenteditable", "false");
    await expect(preview).toHaveText(title);
    await page.waitForTimeout(1_500);
    await expectEditorText(page, legacy);

    // Live again, with the lock's status held back: pending, so still nothing.
    await page.evaluate(() => window.localStorage.setItem("doqtri:editor-view", "live"));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/notes/${id}/lock?**`, async (route) => {
      if (route.request().method() === "GET") await held;
      await route.continue();
    });
    await page.reload();
    await expect(noteEditor(page)).toHaveAttribute("aria-readonly", "true");
    await expect(preview).toHaveText(title);
    await page.waitForTimeout(1_500);

    // Editable now: still nothing until an edit.
    release();
    await editableEditor(page);
    await page.waitForTimeout(1_500);
    await expectEditorText(page, legacy);
    expect(writes).toEqual([]);
    expect(await readNote(id)).toEqual({ title, markdown: legacy });
    await expect(preview).toHaveText(title);
  });

  test("the title line keeps its `# `, never merges with the body, and Enter on it moves into the body", async ({
    page,
  }) => {
    const title = uniqueTitle("Guard Plan");
    const original = `# ${title}${BODY}`;
    const id = await seed(title, original);
    const renames = watchRenames(page, id);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);
    const end = 2 + title.length;

    // Backspace at the start of the title, and over the selected `# `.
    await setEditorSelection(page, 2);
    await page.keyboard.press("Backspace");
    await setEditorSelection(page, 0, 2);
    await page.keyboard.press("Backspace");
    // A `#` typed into the prefix, to make it `##`.
    await setEditorSelection(page, 1);
    await page.keyboard.type("#");
    // Backspace at the start of line 2, Delete at the end of line 1.
    await setEditorSelection(page, end + 1);
    await page.keyboard.press("Backspace");
    await setEditorSelection(page, end);
    await page.keyboard.press("Delete");
    await expectEditorText(page, original);

    // Enter in the middle of the title splits nothing: the caret goes to the body.
    await setEditorSelection(page, 4);
    await page.keyboard.press("Enter");
    await expectEditorText(page, original);
    // Polled: a phone's Enter reaches the editor a moment after the key.
    await expect.poll(async () => (await editorSelection(page)).head).toBe(end + 1);
    // And typing there is body text.
    await page.keyboard.type("Intro.");
    const typed = `# ${title}\nIntro.${BODY.slice(1)}`;
    await expectSaved(id, typed);

    await page.waitForTimeout(1_000);
    expect(renames).toHaveLength(0);
    expect(await readNote(id)).toEqual({ title, markdown: typed });
  });

  test("pasting lines into the title keeps the first as the title, puts the rest at the start of the body, and renames", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const title = uniqueTitle("Paste Plan");
    const id = await seed(title, `# ${title}${BODY}`);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);

    const renamed = uniqueTitle("Pasted Title");
    await setEditorSelection(page, 2, 2 + title.length);
    await page.evaluate((text) => navigator.clipboard.writeText(text), `${renamed}\nB\nC`);
    await page.keyboard.press("ControlOrMeta+v");
    const expected = `# ${renamed}\nB\nC\n${BODY.slice(1)}`;
    await expectEditorText(page, expected);
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({ title: renamed, markdown: expected });
    await layout.expectTitle(page, renamed, title);
  });

  test("emptying the title or replacing the whole note leaves `# ` and renames nothing; a title typed or pasted in renames", async ({
    page,
  }) => {
    const title = uniqueTitle("Kept Title");
    const id = await seed(title, `# ${title}${BODY}`);
    const renames = watchRenames(page, id);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);

    // Everything selected and typed over: the text goes under an empty title.
    await setEditorSelection(page, 0, -1);
    await page.keyboard.type("Body only");
    await expectEditorText(page, "# \nBody only");
    await expectSaved(id, "# \nBody only");
    // Everything selected and deleted: the `# ` stays, with an empty title.
    await setEditorSelection(page, 0, -1);
    await page.keyboard.press("Backspace");
    await expectEditorText(page, "# ");
    await expectSaved(id, "# ");
    await page.waitForTimeout(1_000);
    expect(renames).toHaveLength(0);
    expect((await readNote(id)).title).toBe(title);

    // A title typed into the empty line renames.
    const typed = uniqueTitle("Typed Title");
    await setEditorSelection(page, 2);
    await page.keyboard.type(typed);
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({ title: typed, markdown: `# ${typed}` });
    expect(renames).toHaveLength(1);

    // Pasting over the whole note: a note with its own title line renames by the same rule.
    const pasted = uniqueTitle("Pasted Note");
    await replaceEditorText(page, `# ${pasted}\n\nAll new.`);
    await expect.poll(async () => (await readNote(id)).title, { timeout: 15_000 }).toBe(pasted);
    expect(renames).toHaveLength(2);
  });

  test("deleting the selected title line empties the title, keeps the # heading below in place, and renames nothing", async ({
    page,
  }) => {
    const title = uniqueTitle("Two Headings");
    const second = "# Second part\n\nMore.";
    const id = await seed(title, `# ${title}\n\n${second}`);
    const renames = watchRenames(page, id);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);

    // Select the title line with its line break, and delete it.
    await setEditorSelection(page, 0, `# ${title}\n`.length);
    await page.keyboard.press("Backspace");
    await caretToEnd(page);
    await expectSaved(id, `# \n\n${second}`);
    await page.waitForTimeout(1_500);
    expect(renames).toHaveLength(0);
    expect((await readNote(id)).title).toBe(title);

    // A new title typed into it renames; the heading below is still another section.
    const retyped = uniqueTitle("Retyped Title");
    await setEditorSelection(page, 2);
    await page.keyboard.type(retyped);
    await expect.poll(async () => readNote(id), { timeout: 15_000 }).toEqual({
      title: retyped,
      markdown: `# ${retyped}\n\n${second}`,
    });
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
    // One line at a fixed height, however narrow the page: a longer message
    // ends in an ellipsis, and the whole of it is the line's title.
    await expect(notice(page)).toHaveAttribute("title", warning);
    expect((await notice(page).boundingBox())!.height).toBeLessThanOrEqual(21);
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
