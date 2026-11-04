import { test, expect, type Page } from "@playwright/test";
import { readNote, seedNote, serviceRest, uniqueTitle } from "../helpers";
import { activateWorkspace, createTeamWorkspace, deleteWorkspace, setMember } from "../teams";
import { createChainUser, deleteChainUser, type ChainUser } from "./accounts";
import { MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { readMarketConfig } from "@/lib/stellar/market-reads";
import { assertTestnet, CHAIN_STEP_TIMEOUT_MS, rpcCall, untilConfirmed } from "./testnet";

/**
 * The sanity checklist's on-chain steps, on Stellar testnet (DOQ-19).
 *
 * Two email accounts, A (creator, workspace owner) and B (buyer, member),
 * each with a real passkey smart wallet made through the app's own setup
 * dialog. Chromium's virtual authenticator answers every passkey prompt.
 * Wallets are funded by the app's Friendbot top-up.
 *
 * The steps depend on each other (an anchored note is what gets published,
 * a published template is what B buys), so the file runs in order and stops
 * at the first failure.
 *
 * Server secrets used, all by the dev server, none by this file:
 * DOQTRI_RELAYER_SECRET (submits paid writes), CHANNELS_API_KEY (wallet
 * deploys) and REVOKER_SECRET_KEY (the on-chain removal, last step only).
 */
test.describe.configure({ mode: "serial" });

let A: ChainUser;
let B: ChainUser;
let workspaceId: string | null = null;
const anchoredTitle = uniqueTitle("Chain Note");
const paidTitle = uniqueTitle("Chain Paid");
let anchoredId: string;
let paidId: string;

test.beforeAll(async ({ browser }) => {
  await assertTestnet();
  A = await createChainUser(browser, "a");
  B = await createChainUser(browser, "b");
});

test.afterAll(async () => {
  if (workspaceId) await deleteWorkspace(workspaceId).catch(() => {});
  await deleteChainUser(A);
  await deleteChainUser(B);
});

/**
 * One continuous wait for a toast, bounded by the chain step budget. Toasts
 * leave after a few seconds, so a retry loop with pauses could miss one.
 */
async function toast(page: Page, text: string | RegExp, step: string) {
  try {
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: text }).first()).toBeVisible({
      timeout: CHAIN_STEP_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `"${step}" was not confirmed within ${CHAIN_STEP_TIMEOUT_MS / 1000} s. If the app showed no error, testnet RPC was slow or down: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/** The dialog the vault opens for an email account without a wallet, through to a funded wallet. */
async function setUpWallet(user: ChainUser) {
  const { page } = user;
  await page.goto("/vault");
  const dialog = page.getByTestId("wallet-setup-dialog");
  await expect(dialog.getByRole("heading", { name: "Finish setting up your vault" })).toBeVisible();
  await expect(dialog.getByTestId("wallet-setup-steps")).toContainText("Create your passkey and wallet");
  await dialog.getByTestId("wallet-setup-create").click();

  // The deploy goes through the relay; the first top-up starts with it.
  await untilConfirmed("wallet deploy and first top-up", async () => {
    await expect(dialog.getByRole("heading", { name: "You're ready to anchor" })).toBeVisible({ timeout: 2_000 });
  }, 240_000);
  expect(await user.passkey.credentials()).toHaveLength(1);
  await dialog.getByTestId("wallet-setup-done").click();

  const [wallet] = await serviceRest<{ address: string }[]>(`smart_wallets?user_id=eq.${user.userId}&select=address`);
  expect(wallet?.address).toMatch(/^C[A-Z2-7]{55}$/);
}

/** Opens a note and anchors it from the ship panel; returns once the toast says so. */
async function saveAndAnchor(page: Page, expected: RegExp, step: string) {
  const button = page.getByRole("button", { name: "Save & anchor" });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  await toast(page, expected, step);
}

async function pickOption(page: Page, trigger: string, option: string) {
  await page.getByRole("combobox", { name: trigger }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("A and B set up passkey wallets, and Top up answers", async () => {
  await setUpWallet(A);
  await setUpWallet(B);

  // Funded by the first top-up already, so the route either tops up again
  // or says the wallet has plenty; both are its answers, not errors.
  await A.page.getByTestId("ribbon-profile").click();
  await A.page.getByTestId("top-up").click();
  await toast(A.page, /Wallet topped up with test XLM|already has plenty of test XLM/, "top-up");
  await A.page.keyboard.press("Escape");
});

test("Save & anchor registers v1, then v2, and an up-to-date note offers nothing to anchor", async () => {
  const { page } = A;
  const personal = (await serviceRest<{ id: string }[]>(`workspaces?created_by=eq.${A.userId}&is_personal=eq.true&select=id`))[0].id;
  anchoredId = await seedNote(anchoredTitle, "# Chain Note\n\n## Build the thing\n\nFirst version.\n", undefined, {
    workspaceId: personal,
    userId: A.userId,
  });
  await page.goto(`/vault/${anchoredId}`);
  await saveAndAnchor(page, /Saved & registered as v1/, "first anchor");

  const editor = page.locator("textarea.w-md-editor-text-input");
  await expect(editor).not.toHaveAttribute("readonly", /.*/);
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially("\nSecond version.");
  await saveAndAnchor(page, /Saved & updated to v2/, "second anchor");

  // The chain already holds this text: the button turns itself off, so no
  // second transaction can be sent for the same version.
  await expect(page.getByRole("button", { name: "Save & anchor" })).toBeDisabled();

  // Anchored notes leave the explorer's delete action behind. The explorer
  // reads the ledger when its note list loads, so reload to see this one move.
  await page.reload();
  await expect(page.getByRole("region", { name: "On-chain notes" })).toContainText(anchoredTitle);
  await expect(page.getByRole("img", { name: `${anchoredTitle} is anchored on Stellar and cannot be deleted` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Delete ${anchoredTitle}` })).toHaveCount(0);
});

test("Mark mindmap done, and a node status synced on-chain", async () => {
  const { page } = A;
  await page.getByTestId("mark-done").click();
  await toast(page, /Mindmap marked done and anchored as v\d+/, "mark mindmap done");
  // "Marked done" and its version are separate elements.
  await expect(page.getByText(/Marked done/).first()).toBeVisible();

  await pickOption(page, "Node", "Build the thing");
  await pickOption(page, "Status", "Building");
  await page.getByRole("button", { name: "Sync node status" }).click();
  await toast(page, /synced on-chain/, "sync node status");
});

test("the audit page shows the versions, the build status, and checks a copy", async ({ browser }) => {
  const visitor = await browser.newPage({ storageState: { cookies: [], origins: [] } });
  try {
    const anchored = (await readNote(anchoredId)).markdown;
    // The page is cached for 30 s; reload until it reflects the writes.
    await untilConfirmed("audit page catching up", async () => {
      await visitor.goto(`http://localhost:3000/d/${anchoredId}`);
      await expect(visitor.getByRole("heading", { name: "Version history" })).toBeVisible({ timeout: 2_000 });
      await expect(visitor.getByText("v2", { exact: true }).first()).toBeVisible({ timeout: 2_000 });
      await expect(visitor.getByRole("heading", { name: "Build status" })).toBeVisible({ timeout: 2_000 });
      await expect(visitor.getByText("Building").first()).toBeVisible({ timeout: 2_000 });
    }, 180_000);
    await expect(visitor.getByText(/signed by/).first()).toBeVisible();

    const paste = visitor.getByPlaceholder("…or paste the document text");
    await paste.fill(anchored);
    await visitor.getByRole("button", { name: "Check pasted text" }).click();
    await expect(visitor.getByRole("status").filter({ hasText: /^Match — pasted text is anchored version v\d+/ })).toBeVisible();

    await paste.fill(`${anchored}\nAn edit nobody anchored.\n`);
    await visitor.getByRole("button", { name: "Check pasted text" }).click();
    await expect(visitor.getByRole("status").filter({ hasText: /^No match — pasted text does not equal any anchored version/ })).toBeVisible();
  } finally {
    await visitor.close();
  }
});

test("a team workspace goes on-chain and B's editor role is signed", async () => {
  const { page } = A;
  workspaceId = await createTeamWorkspace(uniqueTitle("Chain Team"), A.userId);
  await setMember(workspaceId, B.userId, "editor");
  await activateWorkspace(page.request, workspaceId);
  await page.goto("/vault/workspace/members");

  await page.getByRole("button", { name: "Create on-chain" }).click();
  await toast(page, "This workspace is on-chain. Grant your members their roles next.", "create on-chain");

  const rowB = page.getByTestId("member-row").filter({ has: page.getByTestId("member-grant") }).first();
  await rowB.getByTestId("member-grant").click();
  await toast(page, "Their on-chain role is in place.", "sign editor role");
});

test("removing B from the team reaches the chain", async () => {
  test.skip(!process.env.REVOKER_SECRET_KEY?.trim(), "REVOKER_SECRET_KEY is not set in .env.chain: removals cannot reach the chain.");
  const { page } = A;
  await page.goto("/vault/workspace/members");
  const rowB = page.getByTestId("member-row").filter({ hasNotText: "(you)" }).first();
  await rowB.getByRole("button", { name: /^Remove / }).click();
  await toast(page, /was removed\./, "remove member");
  await expect(page.getByText("Removal pending on-chain").or(page.getByText("Removed on-chain")).first()).toBeVisible();

  // The queue runs on page loads and on the cron; run the cron route here.
  await untilConfirmed("removal on-chain", async () => {
    const res = await page.request.get("/api/chain/jobs", {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    await page.reload();
    await expect(page.getByTestId("recent-removals")).toContainText("Removed on-chain", { timeout: 2_000 });
  }, 180_000);
});

async function publish(page: Page, noteId: string, title: string, price: "free" | string) {
  await page.goto(`/vault/${noteId}`);
  await page.getByTestId("publish-template").click();
  const dialog = page.getByTestId("publish-template-dialog");
  if (price === "free") {
    await dialog.getByTestId("publish-price-free").click();
  } else {
    await dialog.getByTestId("publish-price-paid").click();
    // XLM, so the buyer's passkey wallet needs no trustline.
    await dialog.getByRole("combobox", { name: "Token" }).click();
    await page.getByTestId("token-option-XLM").click();
    await dialog.getByTestId("publish-price-amount").fill(price);
  }
  await dialog.getByTestId("publish-template-continue").click();
  await dialog.getByTestId("publish-template-sign").click();
  await toast(page, `Published “${title}” to Community templates`, `publish ${price}`);
}

async function openCommunity(page: Page, title: string) {
  await page.goto("/vault/templates");
  const gallery = page.getByTestId("community-gallery");
  await untilConfirmed(`"${title}" listed in Community`, async () => {
    if (!(await gallery.isVisible())) await page.getByRole("tab", { name: /Community/ }).click();
    await expect(gallery.getByRole("button").filter({ hasText: title }).first()).toBeVisible({ timeout: 2_000 });
  });
  await gallery.getByRole("button").filter({ hasText: title }).first().click();
  return page.getByRole("region", { name: `${title} preview` });
}

test("A publishes a free and a paid template on-chain", async () => {
  await publish(A.page, anchoredId, anchoredTitle, "free");

  const personal = (await serviceRest<{ id: string }[]>(`workspaces?created_by=eq.${A.userId}&is_personal=eq.true&select=id`))[0].id;
  paidId = await seedNote(paidTitle, "# Chain Paid\n\n## Paid heading\n\nOnly buyers read this line.\n", undefined, {
    workspaceId: personal,
    userId: A.userId,
  });
  await A.page.goto(`/vault/${paidId}`);
  await saveAndAnchor(A.page, /Saved & registered as v1/, "anchor before publishing");
  await publish(A.page, paidId, paidTitle, "1");
});

test("B buys the paid template and gets its full text", async () => {
  // Publishing works while the market is paused; buying and tipping do not.
  const config = await rpcCall("market get_config", () => readMarketConfig());
  if (config.paused) {
    throw new Error(
      `The testnet market contract (${MARKET_CONTRACT_ID}) is paused, so nothing can be bought or tipped. Its admin must unpause it.`,
    );
  }
  const preview = await openCommunity(B.page, paidTitle);
  await preview.getByTestId("buy-template").click();
  const dialog = B.page.getByTestId("buy-template-dialog");
  await expect(dialog.getByTestId("buy-quote")).toBeVisible();
  // The quote reads balances and simulates the buy; if it finds a problem
  // the button stays off, so say what the dialog says instead of timing out.
  try {
    await expect(dialog.getByTestId("buy-confirm")).toBeEnabled({ timeout: 60_000 });
  } catch {
    throw new Error(`Buy stayed disabled. The dialog says: ${(await dialog.innerText()).replace(/\s+/g, " ")}`);
  }
  await dialog.getByTestId("buy-confirm").click();
  await toast(B.page, `Bought “${paidTitle}”`, "buy");

  await untilConfirmed("the bought note in B's vault", async () => {
    const notes = await serviceRest<{ markdown: string }[]>(`documents?user_id=eq.${B.userId}&select=markdown`);
    expect(notes.some((n) => n.markdown.includes("Only buyers read this line."))).toBe(true);
  }, 30_000);
});

test("B tips the free template's creator and reports the paid one as a copy", async () => {
  const free = await openCommunity(B.page, anchoredTitle);
  await free.getByPlaceholder(/^Tip in /).fill("1");
  await free.getByRole("button", { name: "Tip creator" }).click();
  await toast(B.page, /^Tipped 1 /, "tip");

  const paid = await openCommunity(B.page, paidTitle);
  await paid.getByTestId("report-template").click();
  const dialog = B.page.getByTestId("report-template-dialog");
  await dialog.getByPlaceholder("Search by title or creator").fill(anchoredTitle);
  await dialog.getByRole("listbox", { name: "Original template" }).getByRole("option").filter({ hasText: anchoredTitle }).first().click();
  await dialog.getByTestId("report-submit").click();
  await toast(B.page, "Report sent. Doqtri will compare the two templates.", "report");
});

test("A's Yours tab counts the sale and tip; Change price, Delist and Relist sign", async () => {
  const { page } = A;
  await page.goto("/vault/templates?tab=yours");
  await expect(page.getByTestId("earnings-view")).toBeVisible();
  const total = page.locator('[data-testid^="earnings-total-"]').first();
  // The tab reads every template from the ledger, which takes a while; give
  // each load room to finish before reloading for newer numbers.
  await untilConfirmed("sale and tip in the totals", async () => {
    await page.reload();
    await expect(total).toContainText("Sales", { timeout: 30_000 });
    // A 1 XLM sale pays the creator 0.9 (the market keeps 10%); the tip was 1 XLM.
    await expect(total).toContainText(/Sales\s*0\.9\s*XLM/);
    await expect(total).toContainText(/Tips\s*1\s*XLM/);
  }, 150_000);

  const card = page.locator('[data-testid^="earnings-template-"]').filter({ hasText: paidTitle }).first();
  await card.getByLabel(/^New price in /).fill("2");
  await card.getByRole("button", { name: "Change price" }).click();
  await toast(page, /^Price set to 2 /, "change price");
  await card.getByRole("button", { name: "Delist" }).click();
  await toast(page, "Delisted", "delist");
  await card.getByRole("button", { name: "Relist" }).click();
  await toast(page, "Relisted", "relist");
});
