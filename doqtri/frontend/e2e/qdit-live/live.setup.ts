import { test as setup, expect } from "@playwright/test";
import { assertNotProduction } from "../guard";
import { E2E_KEYPAIR } from "../helpers";
import { walletSessionCookies } from "../wallet-session";
import { LIVE_DOQTRI_HOST, assertLiveTargets } from "./config";

export const LIVE_AUTH_FILE = "e2e/.auth/qdit-live-user.json";

/**
 * A doqtri session on staging for the e2e wallet, through the same
 * challenge -> signature -> /api/auth/wallet exchange as the local suite.
 * The first run creates that wallet's account on the staging branch.
 */
setup("doqtri staging session", async ({ page }) => {
  assertLiveTargets();
  assertNotProduction();

  await page.context().addCookies(await walletSessionCookies(page.request, E2E_KEYPAIR, LIVE_DOQTRI_HOST));
  await page.goto("/vault");
  // proxy.ts sends a request with no session to /login; staying on /vault means the cookies took.
  await page.waitForURL("**/vault");
  expect(new URL(page.url()).pathname).toBe("/vault");

  await page.context().storageState({ path: LIVE_AUTH_FILE });
});
