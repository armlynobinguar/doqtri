import { test, expect } from "@playwright/test";
import { OPENAI_STUB_ORIGIN } from "./openai-stub/config";
import { assertNotProduction } from "./guard";
import { E2E_DOQTRI_ORIGIN } from "./qdit-stub/config";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * The staff pages (DOQ-18), and the referral payouts panel's (DOQ-26). playwright.config.ts lists the default e2e wallet
 * in DOQTRI_ADMINS for the dev server, so the shared session is an admin;
 * a second wallet, listed nowhere, must get a 404 on every one.
 */

const PAGES = [
  { path: "/admin/ops", heading: "Ops" },
  { path: "/admin/promo", heading: "Beta launch promo entries" },
  { path: "/admin/referrals", heading: "Referrals" },
  { path: "/admin/referrals/payouts", heading: "Referral payouts" },
  { path: "/admin/reports", heading: "Template copy reports" },
];

const NOT_ADMIN = e2eKeypair("doqtri-e2e-not-admin");

/** A new context takes the project's signed-in session unless told otherwise. */
const SIGNED_OUT = { cookies: [], origins: [] };

/** The referral payout routes (DOQ-26), each with a well-formed id, so only who's asking decides. */
const ADMIN_ROUTES: { method: "get" | "post" | "patch"; path: string; data?: unknown }[] = [
  { method: "get", path: "/api/admin/referrals/payouts" },
  { method: "get", path: "/api/admin/referrals/payouts?referrer=00000000-0000-4000-8000-000000000001" },
  { method: "post", path: "/api/admin/referrals/payouts", data: {} },
  { method: "patch", path: "/api/admin/referrals/rewards/00000000-0000-4000-8000-000000000001", data: { action: "restore" } },
  { method: "patch", path: "/api/admin/referrals/referrers/00000000-0000-4000-8000-000000000001", data: { limit: 31 } },
];

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

  test("/admin/referrals lists top referrers and recent sign-ups, and links to the payouts", async ({ page }) => {
    await page.goto("/admin/referrals");
    await expect(page.getByText("Top referrers").first()).toBeVisible();
    await expect(page.getByText("Recent sign-ups").first()).toBeVisible();
    await page.getByTestId("referrals-payouts-link").click();
    await expect(page).toHaveURL(/\/admin\/referrals\/payouts$/);
    await expect(page.getByRole("heading", { level: 1, name: "Referral payouts" })).toBeVisible();
  });

  test("the ribbon's admin menu opens Referral payouts", async ({ page }) => {
    await page.goto("/vault");
    await page.getByTestId("ribbon-admin").click();
    await page.getByRole("menuitem", { name: "Referral payouts" }).click();
    await expect(page).toHaveURL(/\/admin\/referrals\/payouts$/);
  });

  test("the referral payout routes are a 404 for anyone else, signed in or not, and never cached", async ({ browser }) => {
    const user = await signedInContext(browser, NOT_ADMIN);
    const anonymous = await browser.newContext({ baseURL: E2E_DOQTRI_ORIGIN, storageState: SIGNED_OUT });
    try {
      for (const context of [user, anonymous]) {
        for (const { method, path, data } of ADMIN_ROUTES) {
          const res = await context.request[method](path, data === undefined ? {} : { data });
          expect(res.status(), `${method.toUpperCase()} ${path}`).toBe(404);
          expect(res.headers()["cache-control"]).toBe("no-store");
        }
      }
      // A signed-out visitor gets the 404 page too.
      const page = await anonymous.newPage();
      await page.goto("/admin/referrals/payouts");
      await expect(page.getByRole("heading", { level: 1, name: "Referral payouts" })).toHaveCount(0);
    } finally {
      await user.close();
      await anonymous.close();
    }
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
