import { test, expect, type Page } from "@playwright/test";
import { deleteNote, seedNote, uniqueTitle } from "./helpers";

/*
 * The vault's compact layout (below `lg`). Runs under the `mobile` project, on
 * a phone viewport with touch, so the drawer, tab bar and note views are
 * exercised the way a phone reaches them.
 */
test.describe("mobile vault", () => {
  let noteId: string;
  let linkedId: string;
  let title: string;
  let linkedTitle: string;

  test.beforeAll(async () => {
    title = uniqueTitle("Mobile Note");
    linkedTitle = uniqueTitle("Mobile Linked");
    noteId = await seedNote(title, `# ${title}\n\n## Plan\n\nBody text.\n`);
    linkedId = await seedNote(linkedTitle, `# ${linkedTitle}\n\nSee [[${title}]].\n`);
  });

  test.beforeEach(async ({ page }) => {
    // `next dev` floats its indicator bubble over the bottom-left corner,
    // which on a phone is the Notes tab. Production builds have no bubble.
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = "nextjs-portal { display: none !important; }";
        document.head.appendChild(style);
      });
    });
  });

  test.afterAll(async () => {
    await deleteNote(noteId);
    await deleteNote(linkedId);
  });

  async function expectNoHorizontalScroll(page: Page) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }

  test("swaps the desktop chrome for a top bar and tab bar", async ({ page }) => {
    await page.goto("/vault");

    const tabs = page.getByRole("navigation", { name: "Primary" });
    await expect(tabs.getByRole("button", { name: "Notes" })).toBeVisible();
    await expect(tabs.getByRole("button", { name: "Mindmap" })).toBeVisible();
    // The ribbon and status bar are desktop-only.
    await expect(page.getByRole("button", { name: "Graph view" })).toBeHidden();
    await expect(page.getByText("Doqtri Dark")).toBeHidden();
    // So is the docked explorer: its notes only appear once the drawer opens.
    await expect(page.getByRole("link", { name: title })).toBeHidden();

    await expect(page.getByRole("heading", { name: "Vault" })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("the Notes drawer opens a note and gets out of the way", async ({ page }) => {
    await page.goto("/vault");

    // Retried: a tap before hydration lands on server HTML with no handler.
    const link = page.getByRole("link", { name: title });
    await expect(async () => {
      // Once open, the drawer's backdrop covers the tab bar.
      if (!(await link.isVisible())) {
        await page.getByRole("button", { name: "Notes" }).tap({ timeout: 2_000 });
      }
      await expect(link).toBeVisible({ timeout: 2_000 });
    }).toPass();

    await link.tap();
    await page.waitForURL(`**/vault/${noteId}`);
    await expect(link).toBeHidden();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  });

  test("a note splits into Note, Map and Ship views", async ({ page }) => {
    await page.goto(`/vault/${noteId}`);

    await expect(page.locator(".w-md-editor-text-input")).toBeVisible();
    // At 16px or more, iOS does not zoom the page when the editor is focused.
    const fontSize = await page
      .locator(".w-md-editor-text-input")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);

    await page.getByRole("tab", { name: "Map" }).tap();
    await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
    await expect(page.getByTestId("backlinks")).toContainText(linkedTitle);
    await expect(page.locator(".w-md-editor-text-input")).toBeHidden();

    await page.getByRole("tab", { name: "Ship" }).tap();
    await expect(page.getByText("Stellar proof")).toBeVisible();

    await page.getByRole("tab", { name: "Note" }).tap();
    await expect(page.locator(".w-md-editor-text-input")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("the tab bar reaches the vault-wide views", async ({ page }) => {
    await page.goto("/vault");
    const tabs = page.getByRole("navigation", { name: "Primary" });

    await expect(async () => {
      await tabs.getByRole("button", { name: "Graph" }).tap();
      await page.waitForURL("**/vault/graph", { timeout: 2_000 });
    }).toPass();
    await expect(page.getByRole("heading", { name: "Graph view" }).first()).toBeVisible();
    await expectNoHorizontalScroll(page);

    await tabs.getByRole("button", { name: "Mindmap" }).tap();
    await page.waitForURL("**/vault/mindmap");
    await expectNoHorizontalScroll(page);
  });
});
