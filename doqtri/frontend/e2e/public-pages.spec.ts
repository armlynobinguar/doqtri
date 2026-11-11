import { test, expect } from "@playwright/test";

/**
 * The pages a visitor sees signed out (DOQ-18): the landing with its live
 * stats, the read-only demo, the docs, the ended promo portal and the
 * signed-out guard in proxy.ts. The audit page has its own spec (audit-page.spec.ts).
 */
test.describe("public pages, signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the landing shows its calls to action and live stats with numbers", async ({ page }) => {
    const stats = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/stats");
    await page.goto("/");
    expect((await stats).ok()).toBeTruthy();

    // The promo has ended (DOQ-50): no announcement links to it.
    await expect(page.locator('a[href="/promo"]')).toHaveCount(0);
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
    // The note renders, read-only: nothing on the page can be typed into.
    const note = page.getByTestId("note-editor").locator(".cm-content");
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute("contenteditable", "false");
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);

    // Nothing to edit, so a plain click on a wikilink opens that demo note.
    await note.locator(".cm-lp-wikilink", { hasText: "Product Roadmap" }).click();
    await page.waitForURL(/\/demo\/product-roadmap$/);
    await expect(page.getByTestId("note-editor").locator(".cm-content")).toContainText("Now");
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

  test("the ended promo portal is a 404 for a visitor", async ({ page }) => {
    // proxy.ts rewrites it to a path no route matches: a real 404 status.
    const res = await page.goto("/promo");
    expect(res?.status()).toBe(404);
    await expect(page).toHaveURL((url) => url.pathname === "/promo");
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByText("Sign in to submit your mindmaps.")).toHaveCount(0);
  });

  test("the vault redirects a signed-out visitor to the landing", async ({ page }) => {
    for (const path of ["/vault", "/vault/graph", "/vault/profile"]) {
      await page.goto(path);
      await expect(page, `${path} should send a visitor to /`).toHaveURL((url) => url.pathname === "/");
    }
  });
});

// The project's storageState: the shared signed-in e2e user.
test.describe("the ended promo, signed in", () => {
  test("the portal is a 404 for a signed-in user too", async ({ page }) => {
    const res = await page.goto("/promo");
    expect(res?.status()).toBe(404);
    await expect(page).toHaveURL((url) => url.pathname === "/promo");
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    // The portal's header link for signed-in users.
    await expect(page.getByRole("link", { name: "Open your mindmap" })).toHaveCount(0);
  });
});
