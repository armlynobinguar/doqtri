import { test, expect, type Page, type Route } from "@playwright/test";
import { deleteNote, E2E_KEYPAIR, editableEditor, expectEditorText, readNote, setEditorSelection, seedNote, serviceRest, uniqueTitle } from "./helpers";
import { signedInContext } from "./wallet-session";

/**
 * Notes housekeeping, profile preferences and the save conflict (DOQ-18).
 * The quick switcher's happy path, the Settings dialog, the note count and
 * the word count have their own tests in vault-shell.spec.ts and
 * editor.spec.ts.
 */

test.describe("notes housekeeping", () => {
  const notes: string[] = [];
  test.afterAll(async () => {
    for (const id of notes) await deleteNote(id);
  });

  /** Holds this note's PATCH (or DELETE) until the test lets it through, or answers it itself. */
  function holdRequest(page: Page, id: string, method: "PATCH" | "DELETE" = "PATCH") {
    let release!: (answer?: (route: Route) => Promise<void>) => void;
    const released = new Promise<((route: Route) => Promise<void>) | undefined>((resolve) => (release = resolve));
    const seen: string[] = [];
    void page.route(`**/api/notes/${id}`, async (route) => {
      if (route.request().method() !== method) return route.fallback();
      seen.push(route.request().postData() ?? "");
      const answer = await released;
      return answer ? answer(route) : route.continue();
    });
    return { release, seen };
  }

  test("rename warns about links, and shows the new title before the server answers", async ({ page }) => {
    const title = uniqueTitle("Rename Me");
    const id = await seedNote(title, "# Rename Me\n\nBody.\n");
    notes.push(id);
    const patch = holdRequest(page, id);
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Rename ${title}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`[[${title}]]`);
    await expect(dialog).toContainText("keep that link, which becomes unresolved");

    const renamed = uniqueTitle("Renamed Note");
    await dialog.getByLabel("Note title").fill(renamed);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();

    // The PATCH is still held: the dialog has closed and every surface has
    // the new title anyway, and the row's rename and delete wait for it.
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: renamed })).toBeVisible();
    await expect(page.getByRole("tab", { name: renamed })).toBeVisible();
    await expect(page.getByRole("button", { name: `Rename ${renamed}` })).toBeDisabled();
    await expect(page.getByRole("button", { name: `Delete ${renamed}` })).toBeDisabled();
    expect(patch.seen).toHaveLength(1);

    patch.release();
    await expect.poll(async () => (await readNote(id)).title).toBe(renamed);
    await expect(page.getByRole("button", { name: `Rename ${renamed}` })).toBeEnabled();
    await expect(page.getByRole("link", { name: renamed })).toBeVisible();
    // The new title on screen is the confirmation; no toast repeats it.
    await expect(page.getByText(`Renamed to “${renamed}”`)).toHaveCount(0);
  });

  test("a refused rename puts the old title back everywhere and offers Retry", async ({ page }) => {
    const title = uniqueTitle("Refused Rename");
    const id = await seedNote(title, "# Refused Rename\n\nBody.\n");
    notes.push(id);
    const patch = holdRequest(page, id);
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Rename ${title}` }).click();
    const dialog = page.getByRole("dialog");
    const renamed = uniqueTitle("Never Saved");
    await dialog.getByLabel("Note title").fill(renamed);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByRole("link", { name: renamed })).toBeVisible();

    // A teammate took the title between the client's check and the write.
    patch.release((route) =>
      route.fulfill({
        status: 409,
        json: { error: `Another note is already called “${renamed}”`, code: "TITLE_TAKEN" },
      }),
    );
    await expect(page.getByText(`Another note is already called “${renamed}”`)).toBeVisible();
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    await expect(page.getByRole("tab", { name: title })).toBeVisible();
    await expect(page.getByRole("link", { name: renamed })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: renamed })).toHaveCount(0);
    expect((await readNote(id)).title).toBe(title);

    // Retry reopens the dialog with what was typed, ready to change.
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("dialog").getByLabel("Note title")).toHaveValue(renamed);
  });

  test("a navigation commits while a rename is still out", async ({ page }) => {
    const title = uniqueTitle("Slow Rename");
    const other = uniqueTitle("Somewhere Else");
    const id = await seedNote(title, "# Slow Rename\n\nBody.\n");
    const otherId = await seedNote(other, "# Somewhere Else\n\nBody.\n");
    notes.push(id, otherId);
    const patch = holdRequest(page, id);
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Rename ${title}` }).click();
    const dialog = page.getByRole("dialog");
    const renamed = uniqueTitle("Renamed Meanwhile");
    await dialog.getByLabel("Note title").fill(renamed);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByRole("link", { name: renamed })).toBeVisible();

    // The PATCH is still held, and the other note opens anyway.
    await page.getByRole("link", { name: other }).click();
    await expect(page).toHaveURL(new RegExp(`/vault/${otherId}$`));
    await expect(page.getByRole("tab", { name: other })).toBeVisible();
    await expect(page.getByRole("link", { name: renamed })).toBeVisible();
    expect(patch.seen).toHaveLength(1);

    patch.release();
    await expect.poll(async () => (await readNote(id)).title).toBe(renamed);
    // The explorer keeps the new title through the refresh that follows.
    await expect(page.getByRole("button", { name: `Rename ${renamed}` })).toBeEnabled();
    await expect(page.getByRole("link", { name: renamed })).toBeVisible();
  });

  test("a rename answered while a navigation is out does not hold the navigation up", async ({ page }) => {
    const title = uniqueTitle("Answered Midway");
    const other = uniqueTitle("Destination");
    const id = await seedNote(title, "# Answered Midway\n\nBody.\n");
    const otherId = await seedNote(other, "# Destination\n\nBody.\n");
    notes.push(id, otherId);
    const patch = holdRequest(page, id);
    const isRsc = (route: Route) => route.request().headers()["rsc"] !== undefined;
    // A refresh of the note being left is slowed right down: had the
    // navigation been batched with one, it would wait this long too.
    await page.route(
      (url) => url.pathname === `/vault/${id}`,
      async (route) => {
        if (isRsc(route)) await new Promise((resolve) => setTimeout(resolve, 8_000));
        await route.fallback();
      },
    );
    // The navigation's own request takes a moment, so the PATCH answers while it is out.
    await page.route(
      (url) => url.pathname === `/vault/${otherId}`,
      async (route) => {
        if (isRsc(route)) await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.fallback();
      },
    );
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Rename ${title}` }).click();
    const dialog = page.getByRole("dialog");
    const renamed = uniqueTitle("Renamed Midway");
    await dialog.getByLabel("Note title").fill(renamed);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();

    await page.getByRole("link", { name: other }).click();
    const answered = page.waitForResponse(
      (res) => res.request().method() === "PATCH" && new URL(res.url()).pathname === `/api/notes/${id}`,
    );
    patch.release();
    await answered;
    await expect(page).toHaveURL(new RegExp(`/vault/${otherId}$`), { timeout: 5_000 });
    await expect(page.getByRole("tab", { name: other })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("link", { name: renamed })).toBeVisible();
    await expect.poll(async () => (await readNote(id)).title).toBe(renamed);
    // The row's actions come back only once a refresh after the navigation
    // has brought the new title and settled the pending rename.
    await expect(page.getByRole("button", { name: `Rename ${renamed}` })).toBeEnabled({ timeout: 15_000 });
  });

  test("a rename that gets no answer says it may not have saved", async ({ page }) => {
    const title = uniqueTitle("Lost Rename");
    const id = await seedNote(title, "# Lost Rename\n\nBody.\n");
    notes.push(id);
    const patch = holdRequest(page, id);
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Rename ${title}` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note title").fill(uniqueTitle("Maybe Saved"));
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();

    patch.release((route) => route.abort("internetdisconnected"));
    await expect(page.getByText(`renaming “${title}” may not have saved`)).toBeVisible();
    await expect(page.getByRole("link", { name: title })).toBeVisible();
  });

  test("a title another note has keeps the dialog open and sends nothing", async ({ page }) => {
    const title = uniqueTitle("Collision Source");
    const taken = uniqueTitle("Collision Target");
    const id = await seedNote(title, "# Collision Source\n\nBody.\n");
    notes.push(id, await seedNote(taken, "# Collision Target\n\nBody.\n"));
    const patch = holdRequest(page, id);
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Rename ${title}` }).click();
    const dialog = page.getByRole("dialog");
    // Case and surrounding spaces do not make it a different title.
    await dialog.getByLabel("Note title").fill(`  ${taken.toUpperCase()} `);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();

    await expect(dialog.getByRole("alert")).toContainText("Another note is already called");
    await expect(dialog).toBeVisible();
    // The open dialog hides the rest of the page from the accessibility tree,
    // so the explorer is checked once it closes: still the old title.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    expect(patch.seen).toHaveLength(0);
  });

  test("delete asks first, then removes the note for good", async ({ page }) => {
    const title = uniqueTitle("Delete Me");
    const id = await seedNote(title, "# Delete Me\n\nBody.\n");
    notes.push(id);
    // The navigation away takes a moment, so the DELETE answers while it is out.
    const vaultRequests: string[] = [];
    await page.route(
      (url) => url.pathname === "/vault",
      async (route) => {
        const headers = route.request().headers();
        // A prefetch carries the rsc header too; only navigations and refreshes count.
        const prefetch =
          headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;
        if (headers["rsc"] !== undefined && !prefetch) {
          vaultRequests.push(route.request().url());
          if (vaultRequests.length === 1) await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
        await route.fallback();
      },
    );
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Delete ${title}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Delete “${title}”` })).toBeVisible();
    await expect(dialog).toContainText("This cannot be undone.");
    await dialog.getByRole("button", { name: "Delete permanently" }).click();

    // The open note is left at once, without waiting for the DELETE.
    await expect(page.getByRole("button", { name: `Delete ${title}` })).toHaveCount(0);
    await expect(page).toHaveURL(/\/vault$/);
    await expect(page.getByText(`Deleted “${title}”`)).toBeVisible();
    await expect.poll(async () => (await readNote(id)) ?? null).toBeNull();
    // The refresh held back during the navigation runs once it commits: a
    // second request for /vault after the navigation's own.
    await expect.poll(() => vaultRequests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  });

  test("a refused delete brings the row back, with the chain icon and a way back to the note", async ({ page }) => {
    const title = uniqueTitle("Refused Delete");
    const id = await seedNote(title, "# Refused Delete\n\nBody.\n");
    notes.push(id);
    const del = holdRequest(page, id, "DELETE");
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Delete ${title}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByRole("link", { name: title })).toHaveCount(0);
    await expect(page).toHaveURL(/\/vault$/);

    // The ledger has it after all: the route refuses as it would for an anchored note.
    del.release((route) =>
      route.fulfill({
        status: 409,
        json: { error: "This note is anchored on Stellar, so it cannot be deleted.", code: "ANCHORED" },
      }),
    );
    await expect(page.getByText("This note is anchored on Stellar, so it cannot be deleted.")).toBeVisible();
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    await expect(page.getByRole("img", { name: `${title} is anchored on Stellar and cannot be deleted` })).toHaveCount(1);
    expect((await readNote(id)).title).toBe(title);

    await page.getByRole("button", { name: "Open note" }).click();
    await expect(page).toHaveURL(new RegExp(`/vault/${id}$`));
  });

  test("the quick switcher says when nothing matches", async ({ page }) => {
    await page.goto("/vault");
    await expect(page.getByText("No note open")).toBeVisible();
    // The shortcut listener attaches on hydration; retry until one press is heard.
    const input = page.getByPlaceholder("Go to note…");
    await expect(async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await expect(input).toBeVisible({ timeout: 2_000 });
    }).toPass();
    await input.fill("zzqx-no-note-has-this-title");
    await expect(page.getByText("No notes found.")).toBeVisible();
  });
});

test.describe("profile", () => {
  async function openTab(page: Page, tab: "account" | "preferences" | "invite") {
    await page.goto("/vault/profile");
    await page.getByTestId(`profile-tab-${tab}`).click();
  }

  test("the Account tab fills in every row", async ({ page }) => {
    await openTab(page, "account");
    for (const label of ["Signed in with", "Member since", "On Stellar since", "Notes", "Network"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText("Stellar Testnet", { exact: true })).toBeVisible();
  });

  test("the Invite tab shows the link and code, and copies the link", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openTab(page, "invite");
    const code = (await page.getByTestId("referral-code").textContent())?.trim() ?? "";
    expect(code).toMatch(/^[a-hjkmnp-z2-9]{8}$/);
    await expect(page.getByTestId("referral-link")).toHaveText(new RegExp(`/r/${code}$`));

    await page.getByRole("button", { name: "Copy link" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/r/${code}$`));
  });

  test("preferences apply at once and follow the account to a second browser", async ({ page, browser }) => {
    await openTab(page, "preferences");
    const root = page.locator("html");
    try {
      await page.getByTestId("pref-theme-light").click();
      await page.getByTestId("pref-editor-text-size-large").click();
      // A switch flips, so set it from whatever an earlier run left behind.
      const motion = page.getByTestId("pref-reduce-motion");
      if ((await motion.getAttribute("aria-checked")) !== "true") await motion.click();
      await expect(motion).toHaveAttribute("aria-checked", "true");
      await expect(root).toHaveClass(/\blight\b/);
      await expect(root).toHaveAttribute("data-text-size", "large");
      await expect(root).toHaveAttribute("data-reduce-motion", "");
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();

      await page.reload();
      await expect(root).toHaveClass(/\blight\b/);
      await expect(root).toHaveAttribute("data-text-size", "large");
      await expect(root).toHaveAttribute("data-reduce-motion", "");

      // A second browser has none of this one's storage; the account carries it.
      const second = await signedInContext(browser, E2E_KEYPAIR);
      try {
        const other = await second.newPage();
        await other.goto("/vault/profile");
        await other.getByTestId("profile-tab-preferences").click();
        await expect(other.getByTestId("pref-theme-light")).toHaveAttribute("aria-checked", "true");
        await expect(other.getByTestId("pref-editor-text-size-large")).toHaveAttribute("aria-checked", "true");
        await expect(other.getByTestId("pref-reduce-motion")).toHaveAttribute("aria-checked", "true");
        await expect(other.locator("html")).toHaveClass(/\blight\b/);
      } finally {
        await second.close();
      }
    } finally {
      // Back to the defaults, which every other spec expects.
      await openTab(page, "preferences");
      await page.getByTestId("pref-theme-dark").click();
      await page.getByTestId("pref-editor-text-size-medium").click();
      if ((await page.getByTestId("pref-reduce-motion").getAttribute("aria-checked")) === "true") {
        await page.getByTestId("pref-reduce-motion").click();
      }
      await expect(root).toHaveClass(/\bdark\b/);
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    }
  });
});

test.describe("save conflict", () => {
  let id: string;
  test.afterEach(async () => deleteNote(id));

  test("a save on a stale version shows the conflict banner, and Reload loads the other text", async ({ page }) => {
    // Opening with its title line (D-120), so opening it writes nothing of its own.
    const title = uniqueTitle("Conflict Note");
    id = await seedNote(title, `# ${title}\n\nFirst text.\n`);
    await page.goto(`/vault/${id}`);
    await editableEditor(page);

    // Someone else's save lands while this copy is open: same note, newer version.
    const [row] = await serviceRest<{ version: number }[]>(`documents?id=eq.${id}&select=version`);
    await serviceRest(`documents?id=eq.${id}`, {
      method: "PATCH",
      body: { markdown: `# ${title}\n\nSaved elsewhere.\n`, version: row.version + 1 },
      prefer: "return=minimal",
    });

    const refused = page.waitForResponse(
      (res) => res.request().method() === "PUT" && new URL(res.url()).pathname === `/api/notes/${id}`,
    );
    await setEditorSelection(page, -1);
    await page.keyboard.type(" My edit.");
    const res = await refused;
    expect(res.status()).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "STALE_VERSION" });

    const banner = page.getByTestId("edit-conflict-banner");
    await expect(banner).toContainText("This note was changed elsewhere since you loaded it");
    await banner.getByRole("button", { name: "Reload" }).click();
    await expectEditorText(page, /Saved elsewhere\./);
    // Nothing was overwritten.
    expect((await readNote(id)).markdown).toContain("Saved elsewhere.");
  });
});
