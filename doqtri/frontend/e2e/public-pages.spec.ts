import { test, expect } from "@playwright/test";

/**
 * The pages a visitor sees signed out (DOQ-18): the landing with its live
 * stats, the read-only demo, the docs, the promo portal and the signed-out
 * guard in proxy.ts. The audit page has its own spec (audit-page.spec.ts).
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("public pages, signed out", () => {
  test("the landing shows its calls to action and live stats with numbers", async ({ page }) => {
    const stats = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/stats");
    await page.goto("/");
    expect((await stats).ok()).toBeTruthy();

    await expect(page.getByText("How to join →")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open your vault" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Try the demo" })).toBeVisible();

    const grid = page.getByRole("region", { name: /Live on Doqtri/ });
    for (const label of ["Sign-ups", "Documents created", "Testnet transactions"]) {
      const card = grid.locator("div").filter({ has: page.locator("dt", { hasText: label }) }).last();
      await expect(card.locator("dd")).toHaveText(/\d/);
    }
  });

  test("Try the demo opens a read-only vault", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Try the demo" }).click();
    await page.waitForURL(/\/demo\/[^/]+$/);
    await expect(page.getByText("Save & anchor is turned off in the demo")).toBeVisible();
    // No editor: the demo renders markdown only.
    await expect(page.locator("textarea.w-md-editor-text-input")).toHaveCount(0);
  });

  test("an unknown demo note is a 404", async ({ page }) => {
    const res = await page.goto("/demo/not-a-note");
    expect(res?.status()).toBe(404);
  });

  test("the docs render", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.getByRole("heading", { level: 1, name: "Doqtri docs" })).toBeVisible();
    for (const section of ["Overview", "Quick start", "Importing documents", "Anchoring on Stellar"]) {
      await expect(page.getByRole("heading", { level: 2, name: section })).toBeVisible();
    }
  });

  test("the promo portal asks a visitor to sign in", async ({ page }) => {
    await page.goto("/promo");
    await expect(page.getByText("Sign in to submit your mindmaps.")).toBeVisible();
  });

  test("the vault redirects a signed-out visitor to the landing", async ({ page }) => {
    for (const path of ["/vault", "/vault/graph", "/vault/profile"]) {
      await page.goto(path);
      await expect(page, `${path} should send a visitor to /`).toHaveURL((url) => url.pathname === "/");
    }
  });
});
