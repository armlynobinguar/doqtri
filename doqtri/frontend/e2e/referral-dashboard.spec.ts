import { randomBytes, randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { assertNotProduction } from "./guard";
import { serviceRest, userIdForWallet } from "./helpers";
import { E2E_DOQTRI_ORIGIN } from "./qdit-stub/config";
import { e2eKeypair, signedInContext } from "./wallet-session";

/**
 * The referral dashboard (WP-4.6, DOQ-24, D-111) from seeded rows. Rows go in
 * with the service role, and activity through the same record_referral_activity()
 * the relay and the sync call, so a referral qualifies the way it would for real.
 * playwright.config.ts turns the dashboard's switch on for the dev server.
 *
 * The payout questionnaire (DOQ-25, D-112) is filled in, reloaded and edited
 * here too, once the first referral is eligible.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Every referred user this spec creates has an email like this, whatever run or
 * referrer made them, so a killed run's can be found and removed by the next.
 */
const LEFTOVER = /^[a-z]{2}\.referral-dashboard-e2e\.[0-9a-f-]+@example\.com$/;

/**
 * An email of this run, and how it shows. The first two letters are all the mask
 * keeps, and the domain isn't kept, so each referred user in a test needs their
 * own two letters to be a row of their own.
 */
function testEmail(prefix: string) {
  const email = `${prefix}.referral-dashboard-e2e.${randomUUID()}@example.com`;
  return { email, masked: `${prefix}•••@•••.com` };
}

const REFERRER = e2eKeypair("doqtri-e2e-referral-dashboard");
const STRANGER = e2eKeypair("doqtri-e2e-referral-stranger");

/** A new context takes the project's signed-in session unless told otherwise. */
const SIGNED_OUT = { cookies: [], origins: [] };

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

/** Fails loudly, so a cleanup that didn't happen doesn't look like one that did. Already gone is fine. */
async function deleteUser(id: string) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adminHeaders });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE user ${id}: ${res.status} ${await res.text()}`);
}

/** Auth users this spec left behind, on any run. */
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

test.describe("referral dashboard", () => {
  test.describe.configure({ mode: "serial" });

  // Unset if beforeAll failed partway, which cleanup has to survive.
  let context: BrowserContext | undefined;
  let page: Page;
  let referrerId: string | undefined;
  // Cleanup deletes users, so it runs only on a project the guard has allowed.
  let allowed = false;

  /** Nothing of this spec's left: this run's, and a killed run's too. Safe however far setup got. */
  async function clean() {
    if (!allowed) return;
    await Promise.all((await leftoverUsers()).map(deleteUser));
    if (!referrerId) return;
    await serviceRest(`referral_payout_profiles?user_id=eq.${referrerId}`, { method: "DELETE" });
    await serviceRest(`referral_rewards?referrer_user_id=eq.${referrerId}`, { method: "DELETE" });
    await serviceRest(`referrals?referrer_user_id=eq.${referrerId}`, { method: "DELETE" });
    await serviceRest(`referral_reward_limits?user_id=eq.${referrerId}`, { method: "DELETE" });
  }

  /** A referred user with an email account, referred an hour ago. */
  async function refer(email: string): Promise<{ id: string; wallet: string }> {
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

  /** The referred user who reaches Eligible, whom a later test deletes. */
  let earner: { id: string; wallet: string } | undefined;

  const rowOf = (identity: string) => page.getByTestId("referrals-row").filter({ hasText: identity });
  const figure = (name: string) => page.getByTestId(`referrals-total-${name}`);

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    assertNotProduction();
    allowed = true;
    context = await signedInContext(browser, REFERRER);
    page = await context.newPage();
    referrerId = await userIdForWallet(REFERRER.publicKey());
    await clean();
  });

  test.afterAll(async () => {
    try {
      await clean();
    } finally {
      await context?.close();
    }
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
    earner = user;
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
    const res = await context!.request.get("/api/referrals");
    expect(res.headers()["cache-control"]).toBe("no-store");
    const body = await res.text();
    for (const secret of [email, user.id, user.wallet, referrerId!]) expect(body).not.toContain(secret);
    expect(JSON.parse(body).rows[0].joinedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("payout details: needed until saved, then submitted, reloaded and edited (DOQ-25)", async ({ browser }) => {
    const card = page.getByTestId("referrals-payout-prompt");
    const dialog = page.getByTestId("payout-dialog");
    const field = (name: string) => dialog.getByTestId(`payout-${name}`);
    const payoutTo = Keypair.random().publicKey();
    const memo = "4242424242";
    const accountNumber = "0917 555 4567";

    await page.goto("/vault/referrals");
    await expect(card).toContainText("Payout details needed");
    await card.getByRole("button", { name: "Add details" }).click();
    await expect(dialog.getByRole("heading", { name: "Payout details" })).toBeVisible();
    await expect(field("name")).toHaveValue("");

    // Nothing filled in, then a save: each required field says so, and focus goes to the first.
    await dialog.getByRole("button", { name: "Save details" }).click();
    await expect(field("name")).toBeFocused();
    await expect(field("name")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByRole("alert").filter({ hasText: "Enter your name." })).toBeVisible();
    await expect(dialog.getByRole("alert").filter({ hasText: "Choose how you'd like to be paid." })).toBeVisible();

    await field("name").fill("E2E Referrer");
    await dialog.getByText("XLM", { exact: true }).click();
    // The user's own wallet is a testnet one, and isn't offered.
    await expect(field("address")).toHaveValue("");
    await expect(dialog.getByTestId("payout-xlm-notes")).toContainText("rewards are real XLM on mainnet");
    await expect(dialog.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    await expect(dialog.getByRole("radio", { name: "Text" })).toBeChecked();

    // A passkey address, then a text memo one byte over: both refused, in the form's words.
    await field("address").fill(`C${payoutTo.slice(1)}`);
    await field("memo").fill("x".repeat(29));
    await expect(field("memo").locator("xpath=..")).toContainText("29/28 characters");
    await dialog.getByRole("button", { name: "Save details" }).click();
    await expect(field("address")).toBeFocused();
    await expect(dialog).toContainText("This is a passkey wallet (C…) address, which can't receive payouts.");
    await expect(dialog).toContainText("A text memo can be at most 28 characters.");

    // An invisible character in a memo, then an ID one past 64 bits: refused too.
    await field("address").fill(payoutTo);
    await field("memo").fill("123456\u200b");
    await dialog.getByRole("button", { name: "Save details" }).click();
    await expect(dialog).toContainText("A text memo can use only English letters, digits, spaces and common symbols.");
    // The radio itself is visually hidden inside its label, as the method cards' are: click what a user sees.
    await dialog.getByText("ID (a number)", { exact: true }).click();
    await expect(dialog.getByRole("radio", { name: "ID (a number)" })).toBeChecked();
    await field("memo").fill("18446744073709551616");
    await dialog.getByRole("button", { name: "Save details" }).click();
    await expect(dialog).toContainText("An ID memo can be at most 18446744073709551615.");

    await field("memo").fill(memo);
    await dialog.getByRole("button", { name: "Save details" }).click();
    await expect(dialog).toBeHidden();
    const saved = page.getByTestId("referrals-payout-saved");
    await expect(saved).toContainText("Payout details saved");
    await expect(saved).toContainText(`XLM ending in ${payoutTo.slice(-4)}, with an ID memo`);
    await expect(card).toHaveCount(0);
    // Focus goes back to the button that opened the form, which is now Edit.
    await expect(saved.getByRole("button", { name: "Edit" })).toBeFocused();

    expect(
      await serviceRest(`referral_payout_profiles?user_id=eq.${referrerId}&select=method,xlm_address,xlm_memo,xlm_memo_type`),
    ).toEqual([{ method: "xlm", xlm_address: payoutTo, xlm_memo: memo, xlm_memo_type: "id" }]);

    // Reload: still saved, still masked, and the prompt stays gone (AC 5, AC 8).
    await page.reload();
    await expect(saved).toContainText(`XLM ending in ${payoutTo.slice(-4)}`);
    await expect(card).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(payoutTo);
    await expect(page.locator("main")).not.toContainText(memo);

    // Edit: the form opens on what's saved, then switches to an e-wallet.
    await saved.getByRole("button", { name: "Edit" }).click();
    await expect(field("address")).toHaveValue(payoutTo);
    await expect(field("memo")).toHaveValue(memo);
    await expect(dialog.getByRole("radio", { name: "ID (a number)" })).toBeChecked();
    await dialog.getByText("E-wallet or bank", { exact: true }).click();
    await dialog.getByRole("combobox", { name: /Provider/ }).click();
    await page.getByRole("option", { name: "Maya" }).click();
    await field("accountName").fill("E2E Referrer");
    await field("accountNumber").fill(accountNumber);
    await dialog.getByRole("button", { name: "Save details" }).click();
    await expect(dialog).toBeHidden();
    await expect(saved).toContainText("Maya ending in 4567");

    await page.reload();
    await expect(saved).toContainText("Maya ending in 4567");
    await saved.getByRole("button", { name: "Edit" }).click();
    await expect(field("accountNumber")).toHaveValue(accountNumber);
    await expect(dialog.getByRole("combobox", { name: /Provider/ })).toContainText("Maya");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    // The stored row holds the e-wallet's details only: the XLM ones are gone (AC 4).
    const rows = await serviceRest<Record<string, unknown>[]>(
      `referral_payout_profiles?user_id=eq.${referrerId}&select=method,name,xlm_address,xlm_memo,xlm_memo_type,ewallet_provider,ewallet_account_number`,
    );
    expect(rows).toEqual([
      {
        method: "ewallet",
        name: "E2E Referrer",
        xlm_address: null,
        xlm_memo: null,
        xlm_memo_type: null,
        ewallet_provider: "Maya",
        ewallet_account_number: accountNumber,
      },
    ]);

    // The route itself: never cached, and the dashboard's answer holds no details.
    const own = await context!.request.get("/api/referrals/payout-profile");
    expect(own.status()).toBe(200);
    expect(own.headers()["cache-control"]).toBe("no-store");
    const dashboard = await (await context!.request.get("/api/referrals")).text();
    for (const secret of [accountNumber, "0917555", payoutTo, memo]) expect(dashboard).not.toContain(secret);

    // Someone without an eligible referral can neither read nor write, whatever they send.
    const other = await signedInContext(browser, STRANGER);
    try {
      const read = await other.request.get(`/api/referrals/payout-profile?user_id=${referrerId}`);
      expect(read.status()).toBe(403);
      expect(await read.text()).not.toContain(accountNumber);
      const write = await other.request.put("/api/referrals/payout-profile", {
        data: { user_id: referrerId, name: "Taken", method: "xlm", address: payoutTo },
      });
      expect(write.status()).toBe(403);
    } finally {
      await other.close();
    }
    expect(
      (await serviceRest<{ name: string }[]>(`referral_payout_profiles?user_id=eq.${referrerId}&select=name`))[0].name,
    ).toBe("E2E Referrer");

    // Signed out: 401, with no session from the project's storageState.
    const anonymous = await browser.newContext({ baseURL: E2E_DOQTRI_ORIGIN, storageState: SIGNED_OUT });
    try {
      expect((await anonymous.request.get("/api/referrals/payout-profile")).status()).toBe(401);
      expect((await anonymous.request.put("/api/referrals/payout-profile", { data: {} })).status()).toBe(401);
    } finally {
      await anonymous.close();
    }
  });

  test("on a phone, the payout form fits without scrolling sideways", async () => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/vault/referrals");
    await page.getByTestId("referrals-payout-saved").getByRole("button", { name: "Edit" }).click();
    const dialog = page.getByTestId("payout-dialog");
    await expect(dialog.getByTestId("payout-accountNumber")).toBeVisible();
    const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    // 16px text in the fields, so iOS doesn't zoom into them.
    const size = await dialog.getByTestId("payout-accountNumber").evaluate((el) => getComputedStyle(el).fontSize);
    expect(size).toBe("16px");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 900 });
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
    const anonymous = await browser.newContext({ baseURL: E2E_DOQTRI_ORIGIN, storageState: SIGNED_OUT });
    try {
      expect((await anonymous.request.get("/api/referrals")).status()).toBe(401);
    } finally {
      await anonymous.close();
    }
  });

  test("a referred user who deletes their account stays as Former user with their reward", async () => {
    // The first one referred, who earned the reward.
    await deleteUser(earner!.id);
    await page.reload();
    const former = rowOf("Former user");
    await expect(former.getByTestId("referrals-status")).toHaveText("Eligible");
    await expect(former.getByTestId("referrals-activity")).toHaveText("—");
    // No date for a former user: it would point at their wallet on the public ledger.
    await expect(former.getByTestId("referrals-joined")).toHaveText("—");
    expect(await former.textContent()).not.toMatch(/20\d\d/);
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

  test("the list pages, and a failed turn keeps what's on screen and retries the same page", async () => {
    // Enough for three pages, on top of the rows the tests above left.
    await Promise.all(Array.from({ length: 41 }, () => refer(testEmail("cc").email)));
    const list = page.getByTestId("referrals-row");
    const range = page.getByTestId("referrals-range");
    const next = page.getByTestId("referrals-next");
    const previous = page.getByTestId("referrals-prev");

    await page.goto("/vault/referrals");
    await expect(list).toHaveCount(20);
    await expect(range).toHaveText(/^1–20 of \d+$/);
    await expect(previous).toHaveAttribute("aria-disabled", "true");

    // Next asks for the next page, not the first.
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(range).toHaveText(/^21–40 of \d+$/);
    await expect(next).toBeFocused();

    // A turn that fails: the list and totals stay, and it says so where the list is.
    const firstRow = await list.first().textContent();
    let asked: string[] = [];
    await page.route("**/api/referrals?page=*", async (route) => {
      asked.push(new URL(route.request().url()).searchParams.get("page")!);
      await route.fulfill({ status: 500, json: { error: "Your referrals couldn't be loaded." } });
    });
    await next.click();
    await expect(page.getByTestId("referrals-page-error")).toContainText("Your referrals couldn't be loaded.");
    await expect(list).toHaveCount(20);
    await expect(list.first()).toHaveText(firstRow!);
    await expect(range).toHaveText(/^21–40 of \d+$/);
    await expect(page.getByTestId("referrals-totals")).toBeVisible();
    expect(asked).toEqual(["3"]);

    // Try again asks for that page again, and this time it comes.
    await page.unrouteAll({ behavior: "wait" });
    asked = [];
    await page.route("**/api/referrals?page=*", async (route) => {
      asked.push(new URL(route.request().url()).searchParams.get("page")!);
      await route.continue();
    });
    await page.getByTestId("referrals-retry").focus();
    await page.keyboard.press("Enter");
    await expect(range).toHaveText(/^41–\d+ of \d+$/);
    await expect(page.getByTestId("referrals-page-error")).toHaveCount(0);
    expect(asked).toEqual(["3"]);
    // The button is gone, and focus went to the list it brought back rather than the page.
    await expect(page.getByRole("heading", { level: 2, name: /Your referrals/ })).toBeFocused();
    await page.unrouteAll({ behavior: "wait" });

    // The last page: Next has nothing left to do, and keeps a keyboard user's focus anyway.
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await next.focus();
    await expect(next).toBeFocused();

    // Back from a full page, on a phone, with the buttons under it: the top of the
    // new list is in view, not its end. (The last page is too short to show this.)
    await page.setViewportSize({ width: 360, height: 740 });
    await previous.click();
    await expect(range).toHaveText(/^21–40 of \d+$/);
    await previous.click();
    await expect(range).toHaveText(/^1–20 of \d+$/);
    const top = await page.getByRole("region", { name: "Your referrals" }).boundingBox();
    expect(top!.y).toBeGreaterThanOrEqual(0);
    expect(top!.y).toBeLessThan(740 / 2);
    await page.setViewportSize({ width: 1440, height: 900 });
  });
});
