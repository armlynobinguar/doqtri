import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { WALLET_EMAIL_DOMAIN } from "@/lib/wallet-address";
import { assertNotProduction } from "./guard";
import { E2E_WALLET, serviceRest, testUserId } from "./helpers";

/**
 * Email sign-up, sign-in, referral codes, password reset and log out
 * (DOQ-18). The e2e branch confirms accounts on creation
 * (mailer_autoconfirm), and no step sends an email: the "Forgot?" form's
 * request is answered in the browser, and the reset link comes from the
 * admin API instead of an inbox.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PASSWORD = "e2e-password-1";

function adminHeaders() {
  return { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" };
}

/** A fresh address on a reserved test domain, so nothing could ever be delivered to it. */
function freshEmail(): string {
  return `e2e-${randomUUID().slice(0, 8)}@example.com`;
}

/** The default e2e user's referral code (created on first use). */
async function e2eReferralCode(): Promise<string> {
  const rows = await serviceRest<{ code: string }[]>("rpc/referral_code_for", {
    method: "POST",
    body: { p_user_id: await testUserId() },
  });
  return rows[0].code;
}

async function userIdByEmail(email: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, { headers: adminHeaders() });
  const body = (await res.json()) as { users: { id: string; email?: string }[] };
  return body.users.find((u) => u.email === email)?.id ?? null;
}

async function createEmailUser(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const text = await res.text();
  expect(res.ok, text).toBeTruthy();
  return (JSON.parse(text) as { id: string }).id;
}

async function deleteUser(id: string | null): Promise<void> {
  if (!id) return;
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adminHeaders() });
}

/** The form's own error. Next.js's route announcer is an empty role="alert" too. */
function formAlert(page: Page) {
  return page.locator('p[role="alert"]');
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("email auth", () => {
  const users: (string | null)[] = [];

  test.beforeAll(() => assertNotProduction());
  test.afterAll(async () => {
    for (const id of users) await deleteUser(id);
  });

  test("sign-up checks the email and the password length", async ({ page }) => {
    await page.goto("/signup");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel("Password").fill("long-enough-password");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(formAlert(page)).toHaveText("Enter a valid email address.");

    await page.getByLabel("Email").fill(freshEmail());
    await page.getByLabel("Password").fill("short1");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(formAlert(page)).toHaveText("Use at least 8 characters for your password.");
  });

  test("a referral code applies and removes", async ({ page }) => {
    const code = await e2eReferralCode();
    await page.goto("/signup");
    await page.getByRole("button", { name: "Have a referral code?" }).click();
    await page.getByTestId("referral-input").fill(code);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByTestId("referral-applied")).toContainText(`Invited with code ${code}`);

    await page.getByTestId("referral-applied").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("button", { name: "Have a referral code?" })).toBeVisible();
  });

  test("an unknown referral code is refused", async ({ page }) => {
    await page.goto("/signup");
    await page.getByRole("button", { name: "Have a referral code?" }).click();
    await page.getByTestId("referral-input").fill("zzzzzzzz");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(formAlert(page)).toHaveText("No one has that referral code.");
  });

  test("a /r/ link prefills the code, and the new account counts for the referrer", async ({ page }) => {
    const code = await e2eReferralCode();
    await page.goto(`/r/${code}`);
    await expect(page).toHaveURL((url) => url.pathname === "/signup");
    await expect(page.getByTestId("referral-applied")).toContainText(`Invited with code ${code}`);

    const email = freshEmail();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/vault"), { timeout: 30_000 });
    const userId = await userIdByEmail(email);
    users.push(userId);
    expect(userId).not.toBeNull();

    // The vault claims the referral on its first load.
    const referrer = await testUserId();
    await expect
      .poll(
        async () =>
          (await serviceRest<{ referrer_user_id: string; source: string }[]>(
            `referrals?referred_user_id=eq.${userId}&select=referrer_user_id,source`,
          ))[0],
        { timeout: 20_000 },
      )
      .toEqual({ referrer_user_id: referrer, source: "link" });
  });

  test("sign-in explains wallet emails and expired links", async ({ page }) => {
    await signIn(page, `${E2E_WALLET.toLowerCase()}@${WALLET_EMAIL_DOMAIN}`, "anything-at-all");
    await expect(formAlert(page)).toHaveText("Wallet accounts sign in with Use Varial wallet, below.");

    await page.goto("/login?error=link");
    await expect(page.getByText("That link is invalid or has expired. Sign in, or request a new one.")).toBeVisible();
  });

  test("a wrong password is refused", async ({ page }) => {
    const email = freshEmail();
    users.push(await createEmailUser(email));
    await signIn(page, email, "not-the-password");
    await expect(formAlert(page)).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  });

  test("forgot and reset password, through an admin recovery link", async ({ page }) => {
    const email = freshEmail();
    users.push(await createEmailUser(email));

    // The form's request to Supabase is answered here, so no email is sent.
    let asked: { email?: string } | null = null;
    await page.route("**/auth/v1/recover**", async (route) => {
      asked = route.request().postDataJSON() as { email?: string };
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot?" }).click();
    await page.waitForURL((url) => url.pathname === "/forgot-password");
    // A submit before hydration is a native form post that reloads the page,
    // so retry until the app's handler takes it.
    await expect(async () => {
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByTestId("reset-sent")).toContainText("Check your inbox", { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    expect(asked).toMatchObject({ email });

    // The link the email would have carried, from the admin API.
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ type: "recovery", email }),
    });
    const text = await res.text();
    expect(res.ok, text).toBeTruthy();
    const link = JSON.parse(text) as { hashed_token?: string; properties?: { hashed_token?: string } };
    const tokenHash = link.hashed_token ?? link.properties?.hashed_token;
    expect(tokenHash, "generate_link returned no hashed_token").toBeTruthy();

    await page.goto(`/auth/confirm?token_hash=${tokenHash}&type=recovery&next=/reset-password`);
    await expect(page.getByText("Choose a new password")).toBeVisible();
    const fresh = "e2e-new-password-2";
    await page.getByLabel("New password").fill(fresh);
    await page.getByRole("button", { name: "Save password" }).click();
    await page.waitForURL((url) => url.pathname.startsWith("/vault"), { timeout: 30_000 });

    // The new password signs in from a clean browser.
    await page.context().clearCookies();
    await signIn(page, email, fresh);
    await page.waitForURL((url) => url.pathname.startsWith("/vault"), { timeout: 30_000 });
  });

  test("log out ends the session", async ({ page }) => {
    const email = freshEmail();
    users.push(await createEmailUser(email));
    await signIn(page, email, PASSWORD);
    await page.waitForURL((url) => url.pathname.startsWith("/vault"), { timeout: 30_000 });

    // A new email account is offered wallet setup on each visit until it
    // picks "Later"; that choice lives in sessionStorage.
    await page.evaluate(() => sessionStorage.setItem("doqtri.walletSetupDismissed", "1"));
    await page.goto("/vault/profile");
    await page.getByTestId("profile-log-out").click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.goto("/vault");
    await expect(page).toHaveURL((url) => url.pathname === "/");
  });
});
