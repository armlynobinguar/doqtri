import { randomUUID } from "node:crypto";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { E2E_DOQTRI_ORIGIN } from "../qdit-stub/config";
import { addVirtualPasskey, type VirtualPasskey } from "./passkey";

/**
 * Email accounts for the chain project (DOQ-19). Each one is made with the
 * admin API (the e2e branch confirms on creation and has no captcha), signs in
 * through the real login form, and carries a virtual passkey, so its wallet is
 * a real passkey smart wallet on testnet.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = "e2e-chain-password-1";

function adminHeaders() {
  return { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" };
}

export type ChainUser = {
  email: string;
  userId: string;
  context: BrowserContext;
  page: Page;
  passkey: VirtualPasskey;
};

export async function createChainUser(browser: Browser, label: string): Promise<ChainUser> {
  const email = `e2e-chain-${label}-${randomUUID().slice(0, 8)}@example.com`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const text = await res.text();
  expect(res.ok, text).toBeTruthy();
  const userId = (JSON.parse(text) as { id: string }).id;

  const context = await browser.newContext({ baseURL: E2E_DOQTRI_ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const passkey = await addVirtualPasskey(page);

  await page.goto("/login");
  await expect(async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/vault"), { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });

  return { email, userId, context, page, passkey };
}

export async function deleteChainUser(user: ChainUser | undefined): Promise<void> {
  if (!user) return;
  await user.context.close().catch(() => {});
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.userId}`, { method: "DELETE", headers: adminHeaders() });
}
