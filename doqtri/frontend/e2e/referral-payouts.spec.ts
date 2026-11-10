import { randomBytes, randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { E2E_ADMIN_WALLET, E2E_SECOND_ADMIN_LABEL, E2E_SECOND_ADMIN_WALLET } from "./admin-wallet";
import { assertNotProduction } from "./guard";
import { serviceRest, userIdForWallet } from "./helpers";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * The referral payouts panel (WP-4.6, DOQ-26) end to end, as the e2e admin (the
 * default session) and a second admin, both listed in DOQTRI_ADMINS by
 * playwright.config.ts. A referrer with two eligible referrals and one over their
 * limit fills in the payout questionnaire through its own route. The admin
 * reviews the referrals and starts the payout, which shows the details as they
 * are now and holds it: the second admin sees "Being paid by" and can't start.
 * The admin records it (pressing twice), and the referrer sees Paid. Then the
 * limit, a void with its reason, a restore, and a payout started and released.
 *
 * Paid rewards and payouts can't be deleted, so cleanup deletes accounts, not
 * rows: this run's referred users and its referrer, whose account the next run's
 * sign-in creates again. What they leave is anonymised (no referrer, no referred
 * user) and never in the queue, so nothing here needs an empty table.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const adminHeaders = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" };

/** Every referred user this spec creates, on any run, so a killed run's can be found and removed by the next. */
const LEFTOVER = /^[a-z]{2}\.referral-payouts-e2e\.[0-9a-f-]+@example\.com$/;
const REFERRER = e2eKeypair("doqtri-e2e-referral-payouts");
const SECOND_ADMIN = e2eKeypair(E2E_SECOND_ADMIN_LABEL);
const ACCOUNT_NUMBER = "0917 555 0142";

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

/** Fails loudly, so a cleanup that didn't happen doesn't look like one that did. Already gone is fine. */
async function deleteUser(id: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adminHeaders });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE user ${id}: ${res.status} ${await res.text()}`);
}

async function leftoverUsers(): Promise<string[]> {
  const found: string[] = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: adminHeaders,
    });
    if (!res.ok) throw new Error(`GET users: ${res.status} ${await res.text()}`);
    const { users } = (await res.json()) as { users: { id: string; email?: string }[] };
    for (const user of users) if (user.email && LEFTOVER.test(user.email)) found.push(user.id);
    if (users.length < perPage) return found;
  }
}

/** The account behind a wallet, if it has signed in before; none is fine. */
async function accountForWallet(address: string): Promise<string | null> {
  const rows = await serviceRest<{ user_id: string }[]>(`wallet_accounts?address=eq.${address}&select=user_id`);
  return rows[0]?.user_id ?? null;
}

test.describe("referral payouts", () => {
  test.describe.configure({ mode: "serial" });

  // Unset if beforeAll failed partway, which cleanup has to survive.
  let referrerContext: BrowserContext | undefined;
  let secondAdmin: BrowserContext | undefined;
  let referrerId: string | undefined;
  // Cleanup deletes accounts, so it runs only on a project the guard has allowed.
  let allowed = false;
  const referred: { email: string; id: string; wallet: string }[] = [];

  /** This spec's accounts gone: this run's, and a killed run's too. Safe however far setup got. */
  async function clean() {
    if (!allowed) return;
    await Promise.all((await leftoverUsers()).map(deleteUser));
    const referrer = await accountForWallet(REFERRER.publicKey());
    if (referrer) await deleteUser(referrer);
  }

  async function refer(prefix: string) {
    const email = `${prefix}.referral-payouts-e2e.${randomUUID()}@example.com`;
    const id = await createUser(email);
    await serviceRest("referrals", {
      method: "POST",
      body: {
        referred_user_id: id,
        referrer_user_id: referrerId,
        code: "abcdefgh",
        source: "link",
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
      },
      prefer: "return=minimal",
    });
    const user = { email, id, wallet: Keypair.random().publicKey() };
    for (let i = 0; i < REFERRAL_ACTIVITY_THRESHOLD; i++) {
      await serviceRest("rpc/record_referral_activity", {
        method: "POST",
        body: {
          p_user_id: id,
          p_network: NETWORK,
          p_tx_hash: randomBytes(32).toString("hex"),
          p_wallet: user.wallet,
          p_fn: "anchor",
          p_occurred_at: new Date().toISOString(),
          p_threshold: REFERRAL_ACTIVITY_THRESHOLD,
          p_reward_php: REFERRAL_REWARD_PHP,
          p_default_limit: REFERRAL_REWARD_LIMIT,
        },
      });
    }
    referred.push(user);
    return user;
  }

  const rowOf = (page: Page) => page.getByTestId("payout-row").filter({ hasText: REFERRER.publicKey() });

  /** What Start payout sends for the referrer's eligible rewards, as the database holds them now. */
  async function requestNow() {
    const rewards = await serviceRest<{ id: string; amount_php: number }[]>(
      `referral_rewards?referrer_user_id=eq.${referrerId}&status=eq.eligible&select=id,amount_php`,
    );
    const details = await serviceRest<{ updated_at: string }[]>(
      `referral_payout_profiles?user_id=eq.${referrerId}&select=updated_at`,
    );
    return {
      referrerId,
      rewardIds: rewards.map((r) => r.id),
      amountPhp: rewards.reduce((sum, r) => sum + r.amount_php, 0),
      detailsUpdatedAt: details[0].updated_at,
    };
  }

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    assertNotProduction();
    allowed = true;
    // Before signing in: the last run's referrer account goes, and with it its rows.
    await clean();
    referrerContext = await signedInContext(browser, REFERRER);
    referrerId = await accountForWallet(REFERRER.publicKey()) ?? undefined;
    expect(referrerId, "signing in should have created the referrer's account").toBeTruthy();
    secondAdmin = await signedInContext(browser, SECOND_ADMIN);

    // A limit of two, then three referrals: two eligible, one over the limit.
    await serviceRest("rpc/set_referral_reward_limit", {
      method: "POST",
      body: { p_user_id: referrerId, p_limit: 2, p_default_limit: REFERRAL_REWARD_LIMIT },
    });
    await refer("aa");
    await refer("bb");
    await refer("cc");

    // The referrer's own questionnaire, through its own route.
    const saved = await referrerContext.request.put("/api/referrals/payout-profile", {
      data: { name: "E2E Payee", method: "ewallet", provider: "GCash", accountName: "E2E Payee", accountNumber: ACCOUNT_NUMBER },
    });
    expect(saved.status(), await saved.text()).toBe(200);
  });

  test.afterAll(async () => {
    try {
      await clean();
    } finally {
      await referrerContext?.close();
      await secondAdmin?.close();
    }
  });

  test("the queue shows the referrer: due date, amount, counts and details in full", async ({ page }) => {
    await page.goto("/admin/referrals/payouts");
    await expect(page.getByRole("heading", { level: 1, name: "Referral payouts" })).toBeVisible();
    const row = rowOf(page);
    await expect(row.getByTestId("payout-owed")).toHaveText(`${2 * REFERRAL_REWARD_PHP} PHP`);
    await expect(row.getByTestId("payout-eligible")).toHaveText("2");
    await expect(row.getByTestId("payout-over-limit")).toHaveText("1");
    await expect(row.getByTestId("payout-paid")).toHaveText("0");
    await expect(row.getByTestId("payout-limit")).toHaveText("2");
    await expect(row.getByTestId("payout-due")).toHaveText(/^Due \d{1,2} \w{3,4} 20\d\d$/);
    await expect(row.getByTestId("payout-details")).toContainText(ACCOUNT_NUMBER);
    await expect(row.getByTestId("payout-details")).toContainText("E-wallet or bank · GCash");
    await expect(row.getByTestId("payout-claim")).toHaveCount(0);
    await expect(page.getByTestId("payouts-manual-note")).toContainText("Nothing is sent automatically.");

    // Review: each referred account in full.
    await row.getByTestId("payout-review-toggle").click();
    const entries = row.getByTestId("payout-referral");
    await expect(entries).toHaveCount(3);
    for (const user of referred) {
      const entry = entries.filter({ hasText: user.email });
      await expect(entry).toContainText(user.wallet);
      await expect(entry.getByTestId("payout-referral-activity")).toContainText(String(REFERRAL_ACTIVITY_THRESHOLD));
    }
    await expect(entries.filter({ hasText: referred[2].email }).getByTestId("payout-referral-status")).toHaveText(/^Over limit/);

    const res = await page.request.get("/api/admin/referrals/payouts");
    expect(res.headers()["cache-control"]).toBe("no-store");
  });

  test("start, a second admin blocked, record (pressed twice), and the referrer sees Paid (AC 3, AC 4)", async ({ page }) => {
    await page.goto("/admin/referrals/payouts");
    const row = rowOf(page);

    // Step one: the details as they are now, held for this admin.
    await row.getByTestId("payout-start").click();
    const dialog = page.getByTestId("payout-pay-dialog");
    await expect(dialog.getByTestId("payout-pay-held")).toContainText("Send it now.");
    await expect(dialog.getByTestId("payout-pay-held")).toContainText("no other admin can start it");
    await expect(dialog.getByTestId("payout-pay-count")).toHaveText("2");
    await expect(dialog.getByTestId("payout-pay-amount")).toHaveText(`${2 * REFERRAL_REWARD_PHP} PHP`);
    await expect(dialog.getByTestId("payout-pay-destination")).toHaveText(`GCash ${ACCOUNT_NUMBER} (E2E Payee)`);

    // The second admin, meanwhile: told who is paying, and can't start.
    const other = await secondAdmin!.newPage();
    try {
      await other.goto("/admin/referrals/payouts");
      const theirs = rowOf(other);
      await expect(theirs.getByTestId("payout-claim")).toContainText(`Being paid by ${E2E_ADMIN_WALLET} since`);
      await expect(theirs.getByTestId("payout-start")).toBeDisabled();
      const blocked = await secondAdmin!.request.post("/api/admin/referrals/payouts", {
        data: { action: "start", ...(await requestNow()) },
      });
      expect(blocked.status()).toBe(409);
      expect(blocked.headers()["cache-control"]).toBe("no-store");
      expect((await blocked.json()).error).toContain(`Being paid by ${E2E_ADMIN_WALLET} since`);
    } finally {
      await other.close();
    }

    // Step two, as fast as a double click.
    await dialog.getByTestId("payout-pay-reference").fill("  GC-REF-0042  ");
    await dialog.getByTestId("payout-pay-confirm").dblclick();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("payouts-notice")).toHaveText(
      `Recorded a payout of ${2 * REFERRAL_REWARD_PHP} PHP for 2 rewards to ${REFERRER.publicKey()}. They now show as Paid.`,
    );
    await expect(row.getByTestId("payout-owed")).toHaveText("0 PHP");
    await expect(row.getByTestId("payout-paid")).toHaveText("2");
    await expect(row.getByTestId("payout-due")).toHaveText("Nothing owed");
    await expect(row.getByTestId("payout-claim")).toHaveCount(0);
    await expect(row.getByTestId("payout-start")).toBeDisabled();

    const payouts = await serviceRest<Record<string, unknown>[]>(
      `referral_payouts?referrer_user_id=eq.${referrerId}&select=id,amount_php,reward_count,method,ewallet_provider,reference,paid_by`,
    );
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({
      amount_php: 2 * REFERRAL_REWARD_PHP,
      reward_count: 2,
      method: "ewallet",
      ewallet_provider: "GCash",
      reference: "GC-REF-0042",
      paid_by: await userIdForWallet(E2E_ADMIN_WALLET),
    });
    expect(JSON.stringify(payouts)).not.toContain(ACCOUNT_NUMBER);
    const paid = await serviceRest<{ id: string; payout_id: string }[]>(
      `referral_rewards?referrer_user_id=eq.${referrerId}&status=eq.paid&select=id,payout_id`,
    );
    expect(paid.map((r) => r.payout_id)).toEqual([payouts[0].id, payouts[0].id]);
    expect(await serviceRest(`referral_payout_claims?referrer_user_id=eq.${referrerId}&select=id`)).toEqual([]);

    // A stale tab recording the same rewards: told plainly they were already paid, by whom and when.
    const stale = await page.request.post("/api/admin/referrals/payouts", {
      data: {
        action: "record",
        referrerId,
        rewardIds: paid.map((r) => r.id),
        amountPhp: 2 * REFERRAL_REWARD_PHP,
        detailsUpdatedAt: (await requestNow()).detailsUpdatedAt,
      },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error).toMatch(
      new RegExp(`already recorded as paid by ${E2E_ADMIN_WALLET} on .+ \\(2 rewards, ${2 * REFERRAL_REWARD_PHP} PHP\\)`),
    );

    // The referrer's dashboard says Paid.
    const referrerPage = await referrerContext!.newPage();
    try {
      await referrerPage.goto("/vault/referrals");
      await expect(referrerPage.getByTestId("referrals-status").filter({ hasText: /^Paid$/ })).toHaveCount(2);
    } finally {
      await referrerPage.close();
    }
  });

  test("set the limit, void with a reason, restore, and a payout started then released (AC 6, AC 7)", async ({ page }) => {
    await page.goto("/admin/referrals/payouts");
    const row = rowOf(page);

    // Raising the limit from 2 to 3 moves the over-limit reward up.
    await row.getByTestId("payout-set-limit").click();
    const limitDialog = page.getByTestId("payout-limit-dialog");
    await expect(limitDialog).toContainText("Lowering it never changes a reward that's already eligible or paid");
    await limitDialog.getByTestId("payout-limit-input").fill("3");
    await limitDialog.getByTestId("payout-limit-confirm").click();
    await expect(limitDialog).toBeHidden();
    await expect(page.getByTestId("payouts-notice")).toHaveText(
      `Set ${REFERRER.publicKey()}'s limit to 3. 1 reward moved up from over the limit to eligible.`,
    );
    await expect(row.getByTestId("payout-eligible")).toHaveText("1");
    await expect(row.getByTestId("payout-owed")).toHaveText(`${REFERRAL_REWARD_PHP} PHP`);

    // Void it: a reason is required.
    await row.getByTestId("payout-review-toggle").click();
    const third = row.getByTestId("payout-referral").filter({ hasText: referred[2].email });
    await expect(third.getByTestId("payout-referral-status")).toHaveText(/^Eligible/);
    await third.getByTestId("payout-referral-void").click();
    const voidDialog = page.getByTestId("payout-void-dialog");
    await voidDialog.getByTestId("payout-void-confirm").click();
    await expect(voidDialog.getByRole("alert")).toHaveText("Give a reason for voiding this reward.");
    await voidDialog.getByTestId("payout-void-reason").fill("Same person as another referred account");
    await voidDialog.getByTestId("payout-void-confirm").click();
    await expect(voidDialog).toBeHidden();
    await expect(third.getByTestId("payout-referral-status")).toHaveText("Void");
    await expect(third).toContainText("Same person as another referred account");
    // The referrer stays in the queue, with the void reward to restore.
    await expect(row.getByTestId("payout-owed")).toHaveText("0 PHP");
    await expect(row.getByTestId("payout-void")).toHaveText("1");

    // Restore it: there's a place, so it's eligible again.
    await third.getByTestId("payout-referral-restore").click();
    await expect(page.getByTestId("payouts-notice")).toHaveText(
      `Restored the reward for ${referred[2].email}. It's eligible again.`,
    );
    await expect(third.getByTestId("payout-referral-status")).toHaveText(/^Eligible/);
    await expect(row.getByTestId("payout-owed")).toHaveText(`${REFERRAL_REWARD_PHP} PHP`);

    // Start, close the dialog (the hold stays), then release it from the row.
    await row.getByTestId("payout-start").click();
    const dialog = page.getByTestId("payout-pay-dialog");
    await expect(dialog.getByTestId("payout-pay-amount")).toHaveText(`${REFERRAL_REWARD_PHP} PHP`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(row.getByTestId("payout-claim")).toContainText("You started this payout at");
    await expect(row.getByTestId("payout-start")).toHaveText("Continue payout");
    await row.getByTestId("payout-release").click();
    await expect(page.getByTestId("payouts-notice")).toHaveText(
      `Released the payout to ${REFERRER.publicKey()}. Nothing was recorded, and another admin can start it now.`,
    );
    await expect(row.getByTestId("payout-claim")).toHaveCount(0);

    // Now the second admin can start it, and release it again through the route.
    const started = await secondAdmin!.request.post("/api/admin/referrals/payouts", {
      data: { action: "start", ...(await requestNow()) },
    });
    expect(started.status(), await started.text()).toBe(200);
    expect((await started.json()).started.details.profile.accountNumber).toBe(ACCOUNT_NUMBER);
    // Focus brings a tab up to date: this one now shows the second admin paying.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(row.getByTestId("payout-claim")).toContainText(`Being paid by ${E2E_SECOND_ADMIN_WALLET}`);
    const released = await secondAdmin!.request.post("/api/admin/referrals/payouts", {
      data: { action: "release", referrerId },
    });
    expect(released.status()).toBe(200);
    expect(await serviceRest(`referral_payouts?referrer_user_id=eq.${referrerId}&select=id`)).toHaveLength(1);
  });

  test("on a phone, the queue and the dialog fit without scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/admin/referrals/payouts");
    const row = rowOf(page);
    await row.getByTestId("payout-review-toggle").click();
    await expect(row.getByTestId("payout-referral")).toHaveCount(3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await row.getByTestId("payout-start").click();
    const dialog = page.getByTestId("payout-pay-dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    // 16px in the field, so iOS doesn't zoom into it.
    expect(await dialog.getByTestId("payout-pay-reference").evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
    await dialog.getByTestId("payout-pay-release").click();
    await expect(dialog).toBeHidden();
    await expect(row.getByTestId("payout-claim")).toHaveCount(0);
  });
});
