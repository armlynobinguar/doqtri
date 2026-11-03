import { test as setup, expect } from "@playwright/test";
import { E2E_KEYPAIR, E2E_WALLET } from "./helpers";
import { walletSessionCookies } from "./wallet-session";

const AUTH_FILE = "e2e/.auth/user.json";

/**
 * Asserts the Connect wallet UI, then seeds a session through the same
 * challenge -> signature -> /api/auth/wallet exchange the app uses (see
 * walletSessionCookies), and saves it for every desktop and mobile spec.
 */
setup("wallet login surface + session seed", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Use Varial wallet/i }),
  ).toBeVisible();

  // An address alone must not open a session.
  const unsigned = await page.request.post("/api/auth/wallet", {
    data: { address: E2E_WALLET },
  });
  expect(unsigned.status()).toBe(401);

  await page.context().addCookies(await walletSessionCookies(page.request, E2E_KEYPAIR));

  await page.goto("/vault");
  await page.waitForURL("**/vault");
  await expect(page.getByText("No note open")).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
