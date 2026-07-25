import { test as setup, expect } from "@playwright/test";
import { TEST_USER } from "./helpers";

const AUTH_FILE = "e2e/.auth/user.json";

/**
 * Signs in through the real login form rather than injecting cookies, so this
 * doubles as the test for the login flow and the proxy.ts redirect.
 */
setup("sign in through the login form", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Open your vault" })).toBeVisible();

  await page.getByPlaceholder("you@example.com").fill(TEST_USER.email);
  await page.getByPlaceholder("Password").fill(TEST_USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // proxy.ts sends a signed-in user away from /login.
  await page.waitForURL("**/vault");
  await expect(page.getByText("No note open")).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
