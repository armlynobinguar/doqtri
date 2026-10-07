import { test, expect } from "@playwright/test";
import { shortenAddress } from "@/lib/wallet";
import { E2E_WALLET, deleteNote, seedNote, uniqueTitle } from "./helpers";

test.describe("vault shell", () => {
  let noteId: string;
  let title: string;

  test.beforeAll(async () => {
    title = uniqueTitle("Shell Note");
    noteId = await seedNote(title, "# Shell Note\n\nBody text.\n");
  });

  test.afterAll(async () => {
    await deleteNote(noteId);
  });

  test("renders the three panes in the brand palette", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);

    // Ribbon
    await expect(page.getByRole("button", { name: "Files" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Graph view" })).toBeVisible();

    // Explorer
    await expect(page.getByText("Vault", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: title })).toBeVisible();

    // Right panel
    await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Mindmap" })).toBeVisible();
    await expect(page.getByText("Backlinks")).toBeVisible();

    // Status bar
    await expect(page.getByText("Doqtri Dark")).toBeVisible();

    /*
     * The palette actually applied, rather than shadcn's default neutral.
     * Chromium reports these as lab(), so rasterize through a canvas to compare
     * in sRGB and confirm the spec's exact hex values reach the screen.
     */
    const toRgb = (cssColor: string) =>
      page.evaluate((color) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      }, cssColor);

    const bodyBg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(await toRgb(bodyBg)).toBe("#08090b");

    const accentVar = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
    );
    expect(await toRgb(accentVar)).toBe("#dcdcf2");
  });

  test("the explorer/editor divider resizes", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);

    const explorer = page.locator('[data-panel][id*="explorer"], [data-panel]').first();
    const before = (await explorer.boundingBox())!.width;

    const handle = page.locator('[data-slot="resizable-handle"]').first();
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(before + 120, 400, { steps: 12 });
    await page.mouse.up();

    const after = (await explorer.boundingBox())!.width;
    expect(after).toBeGreaterThan(before + 40);
  });

  test("the ribbon Files button collapses the explorer", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    const link = page.getByRole("link", { name: title });
    await expect(link).toBeVisible();

    await page.getByRole("button", { name: "Files" }).click();
    await expect(link).toBeHidden();

    await page.getByRole("button", { name: "Files" }).click();
    await expect(link).toBeVisible();
  });

  test("⌘K quick switcher navigates to a note", async ({ page }) => {
    await page.goto("/vault");
    await expect(page.getByText("No note open")).toBeVisible();

    // The shortcut listener attaches on hydration, after the server HTML is
    // already showing, so a press that lands first is dropped. Retry until one
    // is heard.
    const input = page.getByPlaceholder("Go to note…");
    await expect(async () => {
      await page.keyboard.press("ControlOrMeta+k");
      await expect(input).toBeVisible({ timeout: 2_000 });
    }).toPass();

    await input.fill(title);
    await page.getByRole("option", { name: title }).first().click();

    await page.waitForURL(`**/vault/${noteId}`);
    await expect(page.getByRole("tab", { name: title })).toBeVisible();
  });

  test("settings dialog shows the signed-in account", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    await page.getByRole("button", { name: "Settings" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
    // Login is wallet-based, so the account line is the shortened public key
    // rather than an email address.
    await expect(dialog.getByText(shortenAddress(E2E_WALLET))).toBeVisible();
    // Disconnect moved to the account menu.
    await expect(dialog.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  });

  test("account menu shows the vault wallet, balance, and disconnect", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    const trigger = page.getByTestId("account-menu");
    await expect(trigger).toContainText(shortenAddress(E2E_WALLET));
    // Funded or not, the balance resolves to a value rather than staying "…".
    await expect(page.getByTestId("xlm-balance")).not.toHaveText("…", { timeout: 15_000 });

    await trigger.click();
    // Not clicked: signing out would end the session the other tests share.
    await expect(page.getByRole("menuitem", { name: "Disconnect" })).toBeVisible();
  });

  test("a new note appears in the explorer and the note count", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    const explorer = page.getByRole("complementary");
    const before = await explorer.locator('a[href^="/vault/"]').count();

    await page.getByRole("button", { name: "New note" }).click();
    await page.waitForURL((url) => /^\/vault\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(noteId));
    const createdId = new URL(page.url()).pathname.split("/")[2];

    try {
      // The explorer lives in the layout, so it only updates if the layout is
      // re-rendered after navigating to the new note.
      await expect(explorer.locator(`a[href="/vault/${createdId}"]`)).toBeVisible();
      await expect(explorer.locator('a[href^="/vault/"]')).toHaveCount(before + 1);
      await expect(page.getByRole("contentinfo")).toContainText(`${before + 1} notes`);
    } finally {
      await deleteNote(createdId);
    }
  });

  test("upload dialog opens and explains the conversion", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    await page.getByRole("button", { name: "Upload document" }).click();

    await expect(page.getByRole("heading", { name: "Upload document" })).toBeVisible();
    await expect(page.getByText("[[wikilinks]]")).toBeVisible();
    // Nothing chosen yet, so the action stays disabled.
    await expect(page.getByRole("button", { name: "Convert" })).toBeDisabled();
  });
});
