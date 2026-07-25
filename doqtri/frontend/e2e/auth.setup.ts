import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = "e2e/.auth/user.json";

/** Fixed testnet-format key used only for e2e session seeding. */
const E2E_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Asserts Connect wallet UI, then seeds a session via /api/auth/wallet
 * (no Freighter in CI).
 */
setup("wallet login surface + session seed", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Open your vault" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Connect wallet/i }),
  ).toBeVisible();

  const res = await page.request.post("/api/auth/wallet", {
    data: { address: E2E_WALLET },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };

  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(
    ".",
  )[0];
  const storageKey = `sb-${ref}-auth-token`;

  await page.evaluate(
    ({ storageKey, access_token, refresh_token }) => {
      const session = {
        access_token,
        refresh_token,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
      window.localStorage.setItem(storageKey, JSON.stringify(session));
    },
    {
      storageKey,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    },
  );

  await page.goto("/vault");
  await page.waitForURL("**/vault");
  await expect(page.getByText("No note open")).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
