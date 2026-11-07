import { randomBytes, randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { assertNotProduction } from "./guard";
import { serviceRest, userIdForWallet } from "./helpers";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * The referral dashboard (WP-4.6, DOQ-24, D-111) from seeded rows. Rows go in
 * with the service role, and activity through the same record_referral_activity()
 * the relay and the sync call, so a referral qualifies the way it would for real.
 * playwright.config.ts turns the dashboard's switch on for the dev server.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * An email of this run, and how it shows. The first two letters are all the mask
 * keeps, so each referred user in a test needs their own to be a row of their own.
 */
function testEmail(prefix: string) {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
  return { email, masked: `${prefix}•••@example.com` };
}

const REFERRER = e2eKeypair("doqtri-e2e-referral-dashboard");
const STRANGER = e2eKeypair("doqtri-e2e-referral-stranger");

const adminHeaders = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" };

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
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adminHeaders });
}

test.describe("referral dashboard", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;
  let referrerId: string;
  const referred: string[] = [];

  /** Nothing of the last run left for this referrer, or of this one afterwards. */
  async function clean() {
    await Promise.all(referred.splice(0).map(deleteUser));
    await serviceRest(`referral_rewards?referrer_user_id=eq.${referrerId}`, { method: "DELETE" });
    await serviceRest(`referrals?referrer_user_id=eq.${referrerId}`, { method: "DELETE" });
    await serviceRest(`referral_reward_limits?user_id=eq.${referrerId}`, { method: "DELETE" });
  }

  /** A referred user with an email account, referred an hour ago. */
  async function refer(email: string): Promise<{ id: string; wallet: string }> {
    const id = await createUser(email);
    referred.push(id);
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
    return { id, wallet: Keypair.random().publicKey() };
  }

  async function act(user: { id: string; wallet: string }) {
    await serviceRest("rpc/record_referral_activity", {
      method: "POST",
      body: {
        p_user_id: user.id,
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

  const rowOf = (identity: string) => page.getByTestId("referrals-row").filter({ hasText: identity });
  const figure = (name: string) => page.getByTestId(`referrals-total-${name}`);

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    assertNotProduction();
    context = await signedInContext(browser, REFERRER);
    page = await context.newPage();
    referrerId = await userIdForWallet(REFERRER.publicKey());
    await clean();
  });

  test.afterAll(async () => {
    await clean();
    await context.close();
  });

  test("the ribbon opens the page, and with nobody referred it says so and offers the link", async () => {
    await page.goto("/vault");
    await page.getByRole("button", { name: "Referrals" }).click();
    await expect(page).toHaveURL(/\/vault\/referrals$/);
    await expect(page.getByRole("heading", { level: 1, name: "Referrals" })).toBeVisible();
    await expect(page.getByTestId("referrals-empty")).toContainText("No referrals yet");
    await expect(page.getByTestId("referrals-copy-link")).toBeVisible();
    await expect(page.getByTestId("referrals-limit-notice")).toHaveCount(0);
  });

  test("a referred user's activity moves their row from 2 / 3 Pending to Eligible", async () => {
    const { email, masked } = testEmail("aa");
    const user = await refer(email);
    await act(user);
    await act(user);

    await page.goto("/vault/referrals");
    await expect(rowOf(masked).getByTestId("referrals-activity")).toContainText("2 / 3");
    await expect(rowOf(masked).getByTestId("referrals-status")).toHaveText("Pending");
    await expect(figure("earned")).toHaveText(/^0\s*PHP$/);
    await expect(page.getByTestId("referrals-payout-prompt")).toHaveCount(0);

    await act(user);

    await page.reload();
    await expect(rowOf(masked).getByTestId("referrals-activity")).toContainText("3 / 3");
    await expect(rowOf(masked).getByTestId("referrals-status")).toHaveText("Eligible");
    await expect(figure("referred")).toHaveText("1");
    await expect(figure("eligible")).toHaveText("1");
    await expect(figure("earned")).toHaveText(/^30\s*PHP$/);
    await expect(figure("unpaid")).toHaveText(/^30\s*PHP$/);
    await expect(figure("paid")).toHaveText(/^0\s*PHP$/);
    await expect(page.getByTestId("referrals-payout-prompt")).toContainText("Payout details needed");
    await expect(page.locator("main")).not.toContainText(email);

    // The answer itself, not just what's drawn from it.
    const res = await context.request.get("/api/referrals");
    expect(res.headers()["cache-control"]).toBe("no-store");
    const body = await res.text();
    for (const secret of [email, user.id, user.wallet, referrerId]) expect(body).not.toContain(secret);
  });

  test("the limit notice appears at the limit and not below it", async () => {
    await expect(page.getByTestId("referrals-limit-notice")).toHaveCount(0);
    await serviceRest("rpc/set_referral_reward_limit", {
      method: "POST",
      body: { p_user_id: referrerId, p_limit: 1, p_default_limit: REFERRAL_REWARD_LIMIT },
    });
    await page.reload();
    const notice = page.getByTestId("referrals-limit-notice");
    await expect(notice).toContainText("You've reached the limit of 1 reward. To request more, email team@doqtri.xyz");
    await expect(notice.getByRole("link", { name: "team@doqtri.xyz" })).toHaveAttribute(
      "href",
      "mailto:team@doqtri.xyz",
    );
  });

  test("past the limit a referral is Over limit and adds nothing", async () => {
    const { email, masked } = testEmail("bb");
    const user = await refer(email);
    for (let i = 0; i < REFERRAL_ACTIVITY_THRESHOLD; i++) await act(user);

    await page.reload();
    await expect(rowOf(masked).getByTestId("referrals-status")).toHaveText("Over limit");
    await expect(figure("referred")).toHaveText("2");
    await expect(figure("earned")).toHaveText(/^30\s*PHP$/);
  });

  test("someone else's dashboard is empty, whatever they ask for", async ({ browser }) => {
    const other = await signedInContext(browser, STRANGER);
    try {
      const res = await other.request.get(`/api/referrals?user=${referrerId}&p_referrer=${referrerId}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { totals: { referred: number }; rows: unknown[] };
      expect(body.totals.referred).toBe(0);
      expect(body.rows).toEqual([]);
    } finally {
      await other.close();
    }
  });

  test("signed out, the route answers 401", async ({ browser }) => {
    const anonymous = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      expect((await anonymous.request.get("/api/referrals")).status()).toBe(401);
    } finally {
      await anonymous.close();
    }
  });

  test("a referred user who deletes their account stays as Former user with their reward", async () => {
    // The first one referred, who earned the reward.
    await deleteUser(referred.shift()!);
    await page.reload();
    const former = rowOf("Former user");
    await expect(former.getByTestId("referrals-status")).toHaveText("Eligible");
    await expect(former.getByTestId("referrals-activity")).toHaveText("—");
    await expect(figure("earned")).toHaveText(/^30\s*PHP$/);
  });

  test("on a phone: no ribbon, the Invite tab links here, and nothing scrolls sideways", async () => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/vault/profile?tab=invite");
    await expect(page.getByTestId("referral-invite-rule")).toContainText("3 on-chain activities");
    await page.getByTestId("referral-view-dashboard").click();
    await expect(page).toHaveURL(/\/vault\/referrals$/);
    await expect(page.getByTestId("referrals-list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Referrals" })).toBeHidden();
    const overflow = await page.getByTestId("referrals-page").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("a sign-up with a code applied shows the notice", async ({ browser }) => {
    const code = (
      await serviceRest<{ code: string }[]>("rpc/referral_code_for", {
        method: "POST",
        body: { p_user_id: referrerId },
      })
    )[0].code;
    const visitor = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const signUp = await visitor.newPage();
      await signUp.goto("/signup");
      await expect(signUp.getByTestId("referral-notice")).toHaveCount(0);
      await signUp.getByRole("button", { name: "Have a referral code?" }).click();
      await signUp.getByTestId("referral-input").fill(code);
      await signUp.getByRole("button", { name: "Apply" }).click();
      await expect(signUp.getByTestId("referral-notice")).toHaveText(
        "The person who invited you can see a masked version of your email or wallet, and how many on-chain actions you've taken.",
      );
      await signUp.getByTestId("referral-applied").getByRole("button", { name: "Remove" }).click();
      await expect(signUp.getByTestId("referral-notice")).toHaveCount(0);
    } finally {
      await visitor.close();
    }
  });
});
