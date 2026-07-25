import { test as setup, expect } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import { E2E_WALLET } from "./helpers";

const AUTH_FILE = "e2e/.auth/user.json";

/**
 * Asserts the Connect wallet UI, then seeds a session via /api/auth/wallet
 * (no Freighter in CI).
 *
 * The session has to land in *cookies*, not localStorage: proxy.ts and every
 * server component read the session through `@supabase/ssr`, which is
 * cookie-based. Rather than hand-roll that cookie format — it is base64-prefixed
 * and chunked once a session exceeds the size limit — this drives a real
 * `createServerClient` against an in-memory jar and hands whatever it writes to
 * the browser context.
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

  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          for (const { name, value } of cookies) jar.set(name, value);
        },
      },
    },
  );

  const { error } = await supabase.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  expect(error, error?.message).toBeNull();
  expect(jar.size, "setSession wrote no auth cookies").toBeGreaterThan(0);

  await page.context().addCookies(
    [...jar].map(([name, value]) => ({
      name,
      value,
      domain: "localhost",
      path: "/",
    })),
  );

  await page.goto("/vault");
  await page.waitForURL("**/vault");
  await expect(page.getByText("No note open")).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
