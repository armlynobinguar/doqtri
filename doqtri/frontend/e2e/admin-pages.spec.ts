import { test, expect } from "@playwright/test";
import { OPENAI_STUB_ORIGIN } from "./openai-stub/config";
import { assertNotProduction } from "./guard";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * The staff pages (DOQ-18). playwright.config.ts lists the default e2e wallet
 * in DOQTRI_ADMINS for the dev server, so the shared session is an admin;
 * a second wallet, listed nowhere, must get a 404 on every one.
 */

const PAGES = [
  { path: "/admin/ops", heading: "Ops" },
  { path: "/admin/promo", heading: "Beta launch promo entries" },
  { path: "/admin/referrals", heading: "Referrals" },
  { path: "/admin/reports", heading: "Template copy reports" },
];

const NOT_ADMIN = e2eKeypair("doqtri-e2e-not-admin");

test.describe("admin pages", () => {
  test.beforeAll(() => assertNotProduction());

  for (const { path, heading } of PAGES) {
    test(`${path} renders for an admin`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    });
  }

  test("/admin/ops shows its three sections, and its OpenAI probe reaches the stub", async ({ page }) => {
    const before = ((await (await fetch(`${OPENAI_STUB_ORIGIN}/__stub/calls`)).json()) as { models: number }).models;
    await page.goto("/admin/ops");
    for (const section of ["Spendable", "Statuses", "Health"]) {
      await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Relay channels" })).toBeVisible();
    const after = ((await (await fetch(`${OPENAI_STUB_ORIGIN}/__stub/calls`)).json()) as { models: number }).models;
    expect(after, "the ops health probe did not use OPENAI_BASE_URL").toBeGreaterThan(before);
  });

  test("/admin/referrals lists top referrers and recent sign-ups", async ({ page }) => {
    await page.goto("/admin/referrals");
    await expect(page.getByText("Top referrers").first()).toBeVisible();
    await expect(page.getByText("Recent sign-ups").first()).toBeVisible();
  });

  test("every admin page is a 404 for anyone else", async ({ browser }) => {
    const context = await signedInContext(browser, NOT_ADMIN);
    try {
      const page = await context.newPage();
      for (const { path, heading } of PAGES) {
        // The root loading.tsx streams the page before notFound() runs, so
        // the status is 200; what the visitor gets is the 404 page.
        await page.goto(path);
        await expect(page.getByText("This page could not be found."), `${path} should be a 404 for a non-admin`).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: heading })).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });
});
