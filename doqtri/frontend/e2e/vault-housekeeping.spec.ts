import { test, expect, type Page } from "@playwright/test";
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

  test("rename warns about links and renames", async ({ page }) => {
    const title = uniqueTitle("Rename Me");
    const id = await seedNote(title, "# Rename Me\n\nBody.\n");
    notes.push(id);
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Rename ${title}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`[[${title}]]`);
    await expect(dialog).toContainText("keep that link, which becomes unresolved");

    const renamed = uniqueTitle("Renamed Note");
    await dialog.getByLabel("Note title").fill(renamed);
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByText(`Renamed to “${renamed}”`)).toBeVisible();
    await expect.poll(async () => (await readNote(id)).title).toBe(renamed);
  });

  test("delete asks first, then removes the note for good", async ({ page }) => {
    const title = uniqueTitle("Delete Me");
    const id = await seedNote(title, "# Delete Me\n\nBody.\n");
    notes.push(id);
    await page.goto(`/vault/${id}`);

    await page.getByRole("button", { name: `Delete ${title}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Delete “${title}”` })).toBeVisible();
    await expect(dialog).toContainText("This cannot be undone.");
    await dialog.getByRole("button", { name: "Delete permanently" }).click();

    await expect(page.getByText(`Deleted “${title}”`)).toBeVisible();
    await expect(page.getByRole("button", { name: `Delete ${title}` })).toHaveCount(0);
    await expect.poll(async () => (await readNote(id)) ?? null).toBeNull();
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
    id = await seedNote(uniqueTitle("Conflict Note"), "# Conflict Note\n\nFirst text.\n");
    await page.goto(`/vault/${id}`);
    await editableEditor(page);

    // Someone else's save lands while this copy is open: same note, newer version.
    const [row] = await serviceRest<{ version: number }[]>(`documents?id=eq.${id}&select=version`);
    await serviceRest(`documents?id=eq.${id}`, {
      method: "PATCH",
      body: { markdown: "# Conflict Note\n\nSaved elsewhere.\n", version: row.version + 1 },
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
