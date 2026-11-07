import { test, expect, type Page } from "@playwright/test";
import { assertNotProduction } from "./guard";
import { E2E_LEGAL_OPERATOR } from "./legal-operator";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * The Privacy Policy and Terms of Service with their gate on (WP-4.6, D-114):
 * playwright.config.ts gives the dev server a made-up LEGAL_OPERATOR_NAME. The
 * gate-off behaviour needs a server without it, so it is covered by the unit
 * tests in lib/legal.test.ts and app/legal-pages.test.ts.
 */

const PAGES = [
  { path: "/privacy", heading: "Privacy Policy" },
  { path: "/terms", heading: "Terms of Service" },
];

const NOTICE =
  "By creating an account you confirm you are 18 or older, agree to the Terms of Service and acknowledge the Privacy Policy.";

/** A wallet of its own, so its notice state touches no other spec. */
const NOTICE_WALLET = e2eKeypair("doqtri-e2e-legal-notice");

async function expectBothLinks(page: Page) {
  await expect(page.getByRole("link", { name: "Privacy Policy" }).first()).toHaveAttribute("href", "/privacy");
  await expect(page.getByRole("link", { name: "Terms of Service" }).first()).toHaveAttribute("href", "/terms");
}

test.describe("legal pages, signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const { path, heading } of PAGES) {
    test(`${path} opens with a 200 and names the operator`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL((url) => url.pathname === path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.getByText("Last updated")).toBeVisible();
      await expect(page.getByText(E2E_LEGAL_OPERATOR).first()).toBeVisible();
    });
  }

  test("the sitemap lists both and robots.txt allows both", async ({ request }) => {
    const sitemap = await (await request.get("/sitemap.xml")).text();
    const robots = await (await request.get("/robots.txt")).text();
    for (const { path } of PAGES) {
      expect(sitemap).toContain(`${path}</loc>`);
      expect(robots).toContain(`Allow: ${path}`);
    }
  });

  test("the landing footer and the docs link to both", async ({ page }) => {
    await page.goto("/");
    await expectBothLinks(page);
    await page.goto("/docs");
    await expectBothLinks(page);
  });

  test("sign-up shows the notice, with both names linked, before an account exists", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByTestId("sign-up-notice")).toHaveText(NOTICE);
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Use Varial wallet/i })).toBeVisible();
    await expectBothLinks(page);
  });

  test("login shows the notice too, because its wallet button creates new accounts", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("sign-up-notice")).toHaveText(NOTICE);
    await expect(page.getByRole("button", { name: /Use Varial wallet/i })).toBeVisible();
    await expectBothLinks(page);
  });
});

test.describe("legal pages, signed in", () => {
  for (const { path, heading } of PAGES) {
    test(`${path} opens without sending a signed-in user to the vault`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveURL((url) => url.pathname === path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    });
  }

  test("Profile links to both", async ({ page }) => {
    await page.goto("/vault/profile");
    const profile = page.getByRole("main");
    await expect(profile.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
    await expect(profile.getByRole("link", { name: "Terms of Service" })).toBeVisible();
  });

  test("the existing-user notice shows once and stays dismissed after a reload", async ({ browser }) => {
    assertNotProduction();
    const context = await signedInContext(browser, NOTICE_WALLET);
    try {
      const page = await context.newPage();
      await page.goto("/vault");
      const notice = page.getByTestId("legal-update-notice");
      await expect(notice).toContainText("now apply to your account");
      await expectBothLinks(page);

      await notice.getByRole("button", { name: "Dismiss notice" }).click();
      await expect(notice).toHaveCount(0);

      await page.reload();
      await expect(page.getByText("No note open")).toBeVisible();
      await expect(notice).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
