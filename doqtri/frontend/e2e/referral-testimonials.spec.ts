import { randomBytes, randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { E2E_DOQTRI_ORIGIN } from "./qdit-stub/config";
import { assertNotProduction } from "./guard";
import { serviceRest } from "./helpers";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * Referral testimonials (WP-4.6, DOQ-28, D-113) end to end. A referrer with an
 * eligible referral writes feedback in the payout questionnaire. Without the
 * opt-in it is private: admins can read it at /admin/referrals/payouts and can't
 * approve it, and the landing page shows nothing. With the opt-in and an admin's
 * approval (the default session is the e2e admin), the landing page shows the
 * questionnaire's name and the text on the next load. An edit hides it until it
 * is approved again, and unticking the box or deleting the account takes it off.
 *
 * Needs LEGAL_OPERATOR_NAME on, as playwright.config.ts sets it. Cleanup deletes
 * accounts, not rows: the referred user and the referrer, whose testimonial goes
 * with the account.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const adminHeaders = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" };

const LEFTOVER = /^referral-testimonials-e2e\.[0-9a-f-]+@example\.com$/;
const REFERRER = e2eKeypair("doqtri-e2e-referral-testimonials");
const NAME = "E2E Testimonial Giver";
const FIRST = "Doqtri turned my scattered notes into a plan I could ship.";
const EDITED = "Doqtri turned my scattered notes into a plan, and the plan into a release.";

async function createUser(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password: randomUUID(), email_confirm: true }),
  });
  const text = await res.text();
  expect(res.ok, text).toBeTruthy();
  return (JSON.parse(text) as { id: string }).id;
}

async function deleteUser(id: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adminHeaders });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE user ${id}: ${res.status} ${await res.text()}`);
}

async function leftoverUsers(): Promise<string[]> {
  const found: string[] = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, { headers: adminHeaders });
    if (!res.ok) throw new Error(`GET users: ${res.status} ${await res.text()}`);
    const { users } = (await res.json()) as { users: { id: string; email?: string }[] };
    for (const user of users) if (user.email && LEFTOVER.test(user.email)) found.push(user.id);
    if (users.length < perPage) return found;
  }
}

async function accountForWallet(address: string): Promise<string | null> {
  const rows = await serviceRest<{ user_id: string }[]>(`wallet_accounts?address=eq.${address}&select=user_id`);
  return rows[0]?.user_id ?? null;
}

test.describe("referral testimonials", () => {
  test.describe.configure({ mode: "serial" });

  let referrerContext: BrowserContext | undefined;
  let visitorContext: BrowserContext | undefined;
  let referrerPage: Page;
  let visitor: Page;
  let referrerId: string | undefined;
  let allowed = false;

  async function clean() {
    if (!allowed) return;
    await Promise.all((await leftoverUsers()).map(deleteUser));
    const referrer = await accountForWallet(REFERRER.publicKey());
    if (referrer) await deleteUser(referrer);
  }

  /** The landing page as a signed-out visitor sees it, freshly loaded. */
  async function landing() {
    await visitor.goto("/");
    await expect(visitor.getByRole("heading", { level: 1, name: "Doqtri" })).toBeVisible();
    return visitor.getByTestId("landing-testimonials");
  }

  /** The referrer's questionnaire, opened from their dashboard. */
  async function openQuestionnaire() {
    await referrerPage.goto("/vault/referrals");
    await referrerPage.getByTestId("referrals-payout-open").click();
    const dialog = referrerPage.getByTestId("payout-dialog");
    await expect(dialog.getByTestId("payout-form")).toBeVisible();
    return dialog;
  }

  async function save(dialog: ReturnType<Page["getByTestId"]>) {
    await dialog.getByTestId("payout-save").click();
    await expect(dialog).toBeHidden();
  }

  const adminRow = (page: Page) => page.getByTestId("testimonial-row").filter({ hasText: NAME });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    assertNotProduction();
    allowed = true;
    await clean();
    referrerContext = await signedInContext(browser, REFERRER);
    referrerPage = await referrerContext.newPage();
    referrerId = (await accountForWallet(REFERRER.publicKey())) ?? undefined;
    expect(referrerId, "signing in should have created the referrer's account").toBeTruthy();
    // A visitor with no session at all: newContext() inherits the project's storageState otherwise.
    visitorContext = await browser.newContext({ baseURL: E2E_DOQTRI_ORIGIN, storageState: { cookies: [], origins: [] } });
    visitor = await visitorContext.newPage();

    // One eligible referral, so the questionnaire opens.
    const referred = await createUser(`referral-testimonials-e2e.${randomUUID()}@example.com`);
    await serviceRest("referrals", {
      method: "POST",
      body: {
        referred_user_id: referred,
        referrer_user_id: referrerId,
        code: "abcdefgh",
        source: "link",
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
      },
      prefer: "return=minimal",
    });
    const wallet = Keypair.random().publicKey();
    for (let i = 0; i < REFERRAL_ACTIVITY_THRESHOLD; i++) {
      await serviceRest("rpc/record_referral_activity", {
        method: "POST",
        body: {
          p_user_id: referred,
          p_network: NETWORK,
          p_tx_hash: randomBytes(32).toString("hex"),
          p_wallet: wallet,
          p_fn: "anchor",
          p_occurred_at: new Date().toISOString(),
          p_threshold: REFERRAL_ACTIVITY_THRESHOLD,
          p_reward_php: REFERRAL_REWARD_PHP,
          p_default_limit: REFERRAL_REWARD_LIMIT,
        },
      });
    }
  });

  test.afterAll(async () => {
    try {
      await clean();
    } finally {
      await referrerContext?.close();
      await visitorContext?.close();
    }
  });

  test("with none approved, the landing page has no testimonials section at all (AC 6)", async () => {
    const section = await landing();
    await expect(section).toHaveCount(0);
    await expect(visitor.getByRole("heading", { name: "What people map with Doqtri" })).toHaveCount(0);
  });

  test("the questionnaire saves without feedback, with the box unticked (AC 1)", async () => {
    const dialog = await openQuestionnaire();
    await expect(dialog.getByTestId("testimonial-feedback")).toHaveAttribute("placeholder", "I used Doqtri to map my ideas!");
    await expect(dialog.getByTestId("testimonial-consent")).not.toBeChecked();
    await expect(dialog.getByLabel("Doqtri may show my feedback and name publicly.")).not.toBeChecked();
    await dialog.getByTestId("payout-name").fill(NAME);
    await dialog.getByText("XLM", { exact: true }).click();
    await dialog.getByTestId("payout-address").fill(Keypair.random().publicKey());
    await save(dialog);
    const stored = await serviceRest<unknown[]>(`referral_testimonials?user_id=eq.${referrerId}&select=user_id`);
    expect(stored).toEqual([]);
  });

  test("feedback without the opt-in is private: admins read it, can't approve it, and it's never public (AC 2)", async ({ page }) => {
    const dialog = await openQuestionnaire();
    await dialog.getByTestId("testimonial-feedback").fill(FIRST);
    await save(dialog);

    await page.goto("/admin/referrals/payouts");
    const row = adminRow(page);
    await expect(row.getByTestId("testimonial-text")).toHaveText(FIRST);
    await expect(row.getByTestId("testimonial-state")).toHaveText("Private");
    await expect(row.getByTestId("testimonial-private")).toContainText("can't be published");
    await expect(row.getByTestId("testimonial-approve")).toHaveCount(0);

    // Not through the route either.
    const list = await page.request.get("/api/admin/referrals/testimonials");
    expect(list.headers()["cache-control"]).toBe("no-store");
    const mine = ((await list.json()) as { rows: { userId: string; version: string }[] }).rows.find((r) => r.userId === referrerId)!;
    const refused = await page.request.post("/api/admin/referrals/testimonials", {
      data: { userId: referrerId, version: mine.version, decision: "approve" },
    });
    expect(refused.status()).toBe(409);

    await expect(await landing()).toHaveCount(0);
    await expect(visitor.locator("body")).not.toContainText(FIRST);
  });

  test("with the opt-in and an admin's approval it's public, as name and text only (AC 2, AC 3)", async ({ page }) => {
    const dialog = await openQuestionnaire();
    await expect(dialog.getByTestId("testimonial-feedback")).toHaveValue(FIRST);
    await dialog.getByTestId("testimonial-consent").check();
    await save(dialog);

    // Opted in, not yet approved: still nothing public.
    await expect(await landing()).toHaveCount(0);

    await page.goto("/admin/referrals/payouts");
    const row = adminRow(page);
    await expect(row.getByTestId("testimonial-state")).toHaveText("Pending review");
    await row.getByTestId("testimonial-approve").click();
    await expect(page.getByTestId("testimonials-notice")).toContainText(`Approved ${NAME}'s testimonial.`);
    await expect(row.getByTestId("testimonial-state")).toHaveText("Approved");

    const section = await landing();
    await expect(section).toBeVisible();
    await expect(section.getByRole("heading", { name: "What people map with Doqtri" })).toBeVisible();
    const card = section.getByTestId("landing-testimonial").filter({ hasText: FIRST });
    await expect(card).toContainText(NAME);
    const html = await visitor.content();
    for (const secret of [referrerId!, REFERRER.publicKey()]) expect(html).not.toContain(secret);

    // The referrer is told where it stands.
    const again = await openQuestionnaire();
    await expect(again.getByTestId("testimonial-status")).toHaveText("Shown on Doqtri's home page.");
    await again.getByTestId("payout-cancel").click();
  });

  test("an edit takes it off until it's approved again (AC 5)", async ({ page }) => {
    const dialog = await openQuestionnaire();
    await dialog.getByTestId("testimonial-feedback").fill(EDITED);
    await expect(dialog.getByTestId("testimonial-status")).toHaveText("Saving sends your feedback for review again.");
    await save(dialog);

    const hidden = await landing();
    await expect(hidden).toHaveCount(0);
    await expect(visitor.locator("body")).not.toContainText(FIRST);
    await expect(visitor.locator("body")).not.toContainText(EDITED);

    await page.goto("/admin/referrals/payouts");
    const row = adminRow(page);
    await expect(row.getByTestId("testimonial-text")).toHaveText(EDITED);
    await expect(row.getByTestId("testimonial-state")).toHaveText("Pending review");
    await row.getByTestId("testimonial-approve").click();
    await expect(row.getByTestId("testimonial-state")).toHaveText("Approved");

    await expect((await landing()).getByTestId("landing-testimonial").filter({ hasText: EDITED })).toContainText(NAME);
  });

  test("unticking the box takes it off on the next load (AC 4)", async ({ page }) => {
    const dialog = await openQuestionnaire();
    await dialog.getByTestId("testimonial-consent").uncheck();
    await save(dialog);

    await expect(await landing()).toHaveCount(0);
    await expect(visitor.locator("body")).not.toContainText(EDITED);

    await page.goto("/admin/referrals/payouts");
    await expect(adminRow(page).getByTestId("testimonial-state")).toHaveText("Private");
  });

  test("deleting the account takes it off on the next load (AC 4)", async ({ page }) => {
    // Shared and approved once more.
    const dialog = await openQuestionnaire();
    await dialog.getByTestId("testimonial-consent").check();
    await save(dialog);
    await page.goto("/admin/referrals/payouts");
    await adminRow(page).getByTestId("testimonial-approve").click();
    await expect(adminRow(page).getByTestId("testimonial-state")).toHaveText("Approved");
    await expect((await landing()).getByTestId("landing-testimonial").filter({ hasText: EDITED })).toBeVisible();

    await deleteUser(referrerId!);
    await expect(await landing()).toHaveCount(0);
    await expect(visitor.locator("body")).not.toContainText(EDITED);
  });
});
