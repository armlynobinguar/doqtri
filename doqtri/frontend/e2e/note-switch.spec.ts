import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import {
  deleteNote,
  editableEditor,
  expectEditorText,
  personalWorkspaceId,
  readNote,
  seedNote,
  serviceRest,
  setEditorSelection,
  testUserId,
  uniqueTitle,
} from "./helpers";
import { activateWorkspace, createTeamWorkspace, deleteWorkspace } from "./teams";

/*
 * Switching between notes of the active workspace happens on the client
 * (DOQ-43): no request for the note route, no loader, and the URL, history,
 * lock and saves behave as when every switch was a server render.
 */

const NOTE_ROUTE = /^\/vault\/[0-9a-f-]{36}$/;

/** Requests for a note route's RSC payload or document, from now on. */
function watchNoteRouteRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!NOTE_ROUTE.test(url.pathname)) return;
    const rsc = url.searchParams.has("_rsc") || request.headers()["rsc"] === "1";
    if (rsc || request.resourceType() === "document") seen.push(request);
  });
  return seen;
}

/** Records, in the page, whether any navigation loader shows from now on. */
async function watchLoaders(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __loaderSeen?: boolean };
    w.__loaderSeen = false;
    const check = () => {
      if (document.querySelector('.z-20 > [role="status"], [data-testid="note-loading"]')) w.__loaderSeen = true;
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    check();
  });
}

function loaderSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __loaderSeen?: boolean }).__loaderSeen === true);
}

function explorerLink(page: Page, id: string) {
  return page.locator(`[data-note-link="${id}"]`).first();
}

test.describe("note switching", () => {
  const ids: string[] = [];
  let a: { id: string; title: string };
  let b: { id: string; title: string };

  test.beforeEach(async () => {
    const titleA = uniqueTitle("Switch A");
    const titleB = uniqueTitle("Switch B");
    a = { id: await seedNote(titleA, `# ${titleA}\n\n## Alpha theme\n\nalpha body\n`), title: titleA };
    // B links to A, so A's backlinks name B.
    b = {
      id: await seedNote(titleB, `# ${titleB}\n\n## Bravo theme\n\nbravo body, see [[${titleA}]]\n`),
      title: titleB,
    };
    ids.push(a.id, b.id);
  });

  test.afterEach(async () => {
    for (const id of ids.splice(0)) await deleteNote(id);
  });

  test("a switch makes no request for the note route and shows no loader", async ({ page }) => {
    await page.goto(`/vault/${b.id}`);
    await editableEditor(page);
    const requests = watchNoteRouteRequests(page);
    await watchLoaders(page);

    await explorerLink(page, a.id).click();
    await expect(page).toHaveURL(new RegExp(`/vault/${a.id}$`));
    await expectEditorText(page, /alpha body/);
    await editableEditor(page);
    // The panels beside the editor follow the note: B links here, and the
    // live mindmap is A's.
    await expect(page.getByTestId("backlinks").getByText(b.title)).toBeVisible();
    await expect(page.getByTestId("live-mindmap-outline")).toContainText("Alpha theme");
    await expect(page.getByTestId("live-mindmap-outline")).not.toContainText("Bravo theme");
    await expect(page.getByTestId("right-panel").locator("canvas").first()).toBeVisible();
    await expect(explorerLink(page, a.id)).toHaveAttribute("aria-current", "page");

    // The quick switcher opens notes the same way.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByPlaceholder("Go to note…").fill(b.title);
    await page.getByRole("option", { name: b.title }).first().click();
    await expect(page).toHaveURL(new RegExp(`/vault/${b.id}$`));
    await expectEditorText(page, /bravo body/);

    // Give any late request time to show up.
    await page.waitForTimeout(500);
    expect(requests.map((r) => r.url())).toEqual([]);
    expect(await loaderSeen(page)).toBe(false);
    // One editor, not one per visited note.
    await expect(page.getByTestId("note-editor")).toHaveCount(1);

    // A reload is a server render of the URL's note.
    await page.reload();
    await expectEditorText(page, /bravo body/);
  });

  test("a modifier-click opens the note in a new tab and leaves this one as it is", async ({ page, context }) => {
    await page.goto(`/vault/${b.id}`);
    await editableEditor(page);
    const [tab] = await Promise.all([
      context.waitForEvent("page"),
      explorerLink(page, a.id).click({ modifiers: ["ControlOrMeta"] }),
    ]);
    try {
      await tab.waitForURL(`**/vault/${a.id}`);
      await expectEditorText(tab, /alpha body/);
      await expect(page).toHaveURL(new RegExp(`/vault/${b.id}$`));
      await expectEditorText(page, /bravo body/);
    } finally {
      await tab.close();
    }
  });

  test("back and forward between notes stay on the client", async ({ page }) => {
    await page.goto(`/vault/${a.id}`);
    await editableEditor(page);
    await explorerLink(page, b.id).click();
    await expectEditorText(page, /bravo body/);
    const requests = watchNoteRouteRequests(page);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/vault/${a.id}$`));
    await expectEditorText(page, /alpha body/);
    await editableEditor(page);

    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/vault/${b.id}$`));
    await expectEditorText(page, /bravo body/);
    await editableEditor(page);

    await page.waitForTimeout(500);
    expect(requests.map((r) => r.url())).toEqual([]);
  });

  test("a note saved elsewhere since the snapshot shows its newer text, and saves on that version", async ({ page }) => {
    await page.goto(`/vault/${a.id}`);
    await editableEditor(page);

    // Someone else saves B after this page loaded every note.
    await serviceRest(`documents?id=eq.${b.id}`, {
      method: "PATCH",
      body: { markdown: `# ${b.title}\n\nbravo saved elsewhere\n` },
    });
    const [{ version }] = await serviceRest<{ version: number }[]>(`documents?id=eq.${b.id}&select=version`);
    expect(version).toBe(2);

    const saves: { version: number }[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().includes(`/api/notes/${b.id}`)) {
        saves.push(request.postDataJSON() as { version: number });
      }
    });

    await explorerLink(page, b.id).click();
    await expectEditorText(page, /bravo saved elsewhere/);
    await editableEditor(page);
    await setEditorSelection(page, -1);
    await page.keyboard.type("typed here");
    await expect
      .poll(async () => (await readNote(b.id)).markdown, { timeout: 15_000 })
      .toBe(`# ${b.title}\n\nbravo saved elsewhere\ntyped here`);

    // The first save already named the newer version: nothing was refused.
    expect(saves[0]?.version).toBe(2);
    await expect(page.getByTestId("edit-conflict-banner")).toHaveCount(0);
  });

  /** Types at the end of the open note and waits for the lock its first keystroke takes. */
  async function typeWithLock(page: Page, id: string, text: string) {
    await editableEditor(page);
    await setEditorSelection(page, -1);
    const locked = page.waitForResponse(
      (res) => res.url().includes(`/api/notes/${id}/lock`) && res.request().method() === "POST",
    );
    await page.keyboard.type(text);
    await locked;
  }

  /** The PUTs to a note's save route, with their bodies. */
  function watchSaves(page: Page, id: string): { markdown: string; release?: boolean }[] {
    const saves: { markdown: string; release?: boolean }[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === `/api/notes/${id}`) {
        saves.push(request.postDataJSON() as { markdown: string; release?: boolean });
      }
    });
    return saves;
  }

  test("text typed just before a switch is saved as the editor closes", async ({ page }) => {
    await page.goto(`/vault/${a.id}`);
    const saves = watchSaves(page, a.id);
    // Away before the autosave's debounce ends.
    await typeWithLock(page, a.id, "unsaved words");
    await explorerLink(page, b.id).click();
    await expectEditorText(page, /bravo body/);

    // Saved on leaving, with the lock released by that same request.
    await expect.poll(() => saves.length).toBeGreaterThan(0);
    expect(saves.at(-1)).toMatchObject({ markdown: expect.stringMatching(/unsaved words$/), release: true });
    await expect
      .poll(async () => (await readNote(a.id)).markdown, { timeout: 15_000 })
      .toBe(`# ${a.title}\n\n## Alpha theme\n\nalpha body\nunsaved words`);

    // Coming back shows it, editable: the lock was let go.
    await explorerLink(page, a.id).click();
    await expectEditorText(page, /alpha body\nunsaved words$/);
    await editableEditor(page);
  });

  test("text typed just before a switch survives a reload right after it", async ({ page }) => {
    await page.goto(`/vault/${a.id}`);
    await typeWithLock(page, a.id, "last words");
    await explorerLink(page, b.id).click();
    await page.reload();
    await expect
      .poll(async () => (await readNote(a.id)).markdown, { timeout: 15_000 })
      .toBe(`# ${a.title}\n\n## Alpha theme\n\nalpha body\nlast words`);
    // The save took the lock with it: A opens editable, not "elsewhere".
    await page.goto(`/vault/${a.id}`);
    await expectEditorText(page, /last words$/);
    await editableEditor(page);
    await expect(page.getByTestId("edit-lock-elsewhere-banner")).toHaveCount(0);
  });

  /** Makes A's last save as its editor closes fail, as a server error. */
  async function failLastSave(page: Page): Promise<() => boolean> {
    let failed = false;
    await page.route(`**/api/notes/${a.id}`, async (route) => {
      const request = route.request();
      if (request.method() === "PUT" && (request.postDataJSON() as { release?: boolean }).release) {
        failed = true;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
        return;
      }
      await route.fallback();
    });
    return () => failed;
  }

  test("text a failed last save left comes back, and is saved when the note has not moved on", async ({ page }) => {
    await page.goto(`/vault/${a.id}`);
    const failed = await failLastSave(page);
    await typeWithLock(page, a.id, "kept words");
    await explorerLink(page, b.id).click();
    await expect.poll(failed).toBe(true);
    await page.unrouteAll();
    expect((await readNote(a.id)).markdown).not.toMatch(/kept words/);

    await explorerLink(page, a.id).click();
    await expectEditorText(page, /alpha body\nkept words$/);
    await expect
      .poll(async () => (await readNote(a.id)).markdown, { timeout: 15_000 })
      .toBe(`# ${a.title}\n\n## Alpha theme\n\nalpha body\nkept words`);
    await expect(page.getByTestId("edit-conflict-banner")).toHaveCount(0);
  });

  test("text a failed last save left comes back with the conflict banner when the note moved on", async ({ page }) => {
    await page.goto(`/vault/${a.id}`);
    const failed = await failLastSave(page);
    await typeWithLock(page, a.id, "kept words");
    await explorerLink(page, b.id).click();
    await expect.poll(failed).toBe(true);
    await page.unrouteAll();
    // Someone else saves A meanwhile.
    await serviceRest(`documents?id=eq.${a.id}`, {
      method: "PATCH",
      body: { markdown: `# ${a.title}\n\nalpha theirs\n` },
    });

    await explorerLink(page, a.id).click();
    await expect(page.getByTestId("edit-conflict-banner")).toBeVisible();
    // The text stays to be copied, and nothing overwrote theirs.
    await expectEditorText(page, /kept words$/);
    await page.waitForTimeout(1_500);
    expect((await readNote(a.id)).markdown).toBe(`# ${a.title}\n\nalpha theirs\n`);
  });

  test("the edit lock is taken on the first keystroke and released on leaving", async ({ page, context }) => {
    await page.goto(`/vault/${a.id}`);
    await editableEditor(page);
    await explorerLink(page, b.id).click();
    await editableEditor(page);
    await setEditorSelection(page, -1);
    await page.keyboard.type("x");
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });

    const other = await context.newPage();
    try {
      // The same account in another tab is read-only, with "Edit here".
      await other.goto(`/vault/${b.id}`);
      await expect(
        other.getByTestId("edit-lock-elsewhere-banner").getByRole("button", { name: "Edit here" }),
      ).toBeVisible();

      // Leaving B releases its lock: a fresh copy can edit.
      await explorerLink(page, a.id).click();
      await expectEditorText(page, /alpha body/);
      await expect(async () => {
        await other.reload();
        await editableEditor(other);
        await expect(other.getByTestId("edit-lock-elsewhere-banner")).toHaveCount(0);
      }).toPass({ timeout: 20_000 });
    } finally {
      await other.close();
    }
  });

  test("a refresh after a switch leaves the open editor as it is", async ({ page }) => {
    await page.goto(`/vault/${a.id}`);
    await editableEditor(page);
    await explorerLink(page, b.id).click();
    await editableEditor(page);
    await setEditorSelection(page, -1);
    await page.keyboard.type("kept");
    // Tag the editor's element: a remount would replace it.
    await page.getByTestId("note-editor").evaluate((el) => el.setAttribute("data-e2e-mark", "1"));

    // Renaming another note refreshes the vault's server data, which
    // renders the note page for the URL's note, not the one it was loaded for.
    const renamed = uniqueTitle("Switch A renamed");
    await page.getByRole("button", { name: `Rename ${a.title}` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note title").fill(renamed);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect.poll(async () => (await readNote(a.id)).title).toBe(renamed);
    await expect(page.getByRole("button", { name: `Rename ${renamed}` })).toBeEnabled();

    await expect(page.getByTestId("note-editor")).toHaveAttribute("data-e2e-mark", "1");
    await expectEditorText(page, /bravo body[^]*\nkept$/);
    await expect(page.getByTestId("note-editor")).toHaveCount(1);
    await expect
      .poll(async () => (await readNote(b.id)).markdown, { timeout: 15_000 })
      .toMatch(/\nkept$/);
  });

  test("back from a note to a page that is not one shows no loader on the way", async ({ page }) => {
    await page.goto("/vault/graph");
    await explorerLink(page, a.id).click();
    await expectEditorText(page, /alpha body/);
    await watchLoaders(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/vault\/graph$/);
    await expect(page.getByTestId("note-editor")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await loaderSeen(page)).toBe(false);
  });

  test("back to a note deleted since goes through the server", async ({ page }) => {
    await page.goto(`/vault/${a.id}`);
    await editableEditor(page);
    await explorerLink(page, b.id).click();
    await expectEditorText(page, /bravo body/);

    await page.getByRole("button", { name: `Delete ${b.title}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete permanently" }).click();
    await expect(page).toHaveURL(/\/vault$/);
    await expect.poll(async () => (await readNote(b.id)) ?? null).toBeNull();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/vault/${b.id}$`));
    await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
    await expect(page.getByTestId("note-editor")).toHaveCount(0);
  });

  test("an unknown id, and another workspace's note, go through the server", async ({ page }) => {
    await page.goto(`/vault/${a.id}`);
    await editableEditor(page);
    await page.goto(`/vault/${randomUUID()}`);
    await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();

    const me = await testUserId();
    const team = await createTeamWorkspace(uniqueTitle("Switch Team"), me);
    const title = uniqueTitle("Team note");
    const teamNote = await seedNote(title, `# ${title}\n\nteam body\n`, undefined, { workspaceId: team, userId: me });
    try {
      await page.goto(`/vault/${a.id}`);
      await editableEditor(page);
      // The server moves the vault to the note's workspace and opens it.
      await page.goto(`/vault/${teamNote}`);
      await expect(page).toHaveURL(new RegExp(`/vault/${teamNote}$`));
      await expectEditorText(page, /team body/);
      await expect(explorerLink(page, a.id)).toHaveCount(0);
    } finally {
      await activateWorkspace(page.request, await personalWorkspaceId(me));
      await deleteNote(teamNote);
      await deleteWorkspace(team);
    }
  });

  test("from a page that is not a note, a note opens through the server", async ({ page }) => {
    await page.goto("/vault/graph");
    const requests = watchNoteRouteRequests(page);
    await explorerLink(page, a.id).click();
    await expect(page).toHaveURL(new RegExp(`/vault/${a.id}$`));
    await expectEditorText(page, /alpha body/);
    expect(requests.length).toBeGreaterThan(0);
  });
});
