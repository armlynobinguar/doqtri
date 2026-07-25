import { test, expect } from "@playwright/test";
import { deleteNote, seedNote, uniqueTitle } from "./helpers";

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

  test("renders the three panes in the Cursor palette", async ({ page }) => {
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
    await expect(page.getByText("Cursor Dark")).toBeVisible();

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
    expect(await toRgb(bodyBg)).toBe("#1e1e1e");

    const accentVar = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
    );
    expect(await toRgb(accentVar)).toBe("#4d9dff");
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

    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByPlaceholder("Go to note…");
    await expect(input).toBeVisible();

    await input.fill(title);
    await page.getByRole("option", { name: title }).first().click();

    await page.waitForURL(`**/vault/${noteId}`);
    await expect(page.getByRole("tab", { name: title })).toBeVisible();
  });

  test("settings dialog shows the signed-in account", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);
    await page.getByRole("button", { name: "Settings" }).click();

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("alice.mindmap@gmail.com")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
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
