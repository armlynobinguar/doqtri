import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferralPayouts } from "@/components/admin/referral-payouts";
import {
  PAYOUTS_ROUTE,
  createSingleFlight,
  fetchQueue,
  formatDay,
  formatTime,
  limitMessage,
  markPaid,
  markPaidRequest,
  paidMessage,
  payoutRequest,
  releasePayout,
  startPayout,
  restoreMessage,
  setLimit,
  voidReward,
} from "@/components/admin/referral-payouts-client";
import type { PayoutQueueRow } from "@/lib/referral-payouts";

/*
 * The payouts panel's logic (WP-4.6, DOQ-26), and what it draws, rendered to
 * static markup since the unit tests run in Node without a DOM.
 */

const ADDRESS = `G${"A".repeat(55)}`;

const row = (over: Partial<PayoutQueueRow> = {}): PayoutQueueRow => ({
  referrerId: "00000000-0000-4000-8000-0000000000c3",
  identity: "referrer@example.com",
  eligibleRewardIds: ["00000000-0000-4000-8000-0000000000d4", "00000000-0000-4000-8000-0000000000d5"],
  eligibleCount: 2,
  overLimitCount: 1,
  paidCount: 3,
  voidCount: 0,
  owedPhp: 75,
  limit: 30,
  limitRaised: false,
  details: {
    profile: { method: "xlm", name: "Payout Holder", address: ADDRESS, memo: "4242", memoType: "id" },
    savedAt: "2026-10-01T00:00:00+00:00",
    updatedAt: "2026-10-02T00:00:00+00:00",
  },
  due: { state: "due", dueAt: "2026-11-01T00:00:00.000Z", overdue: true },
  claim: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

const STARTED_DETAILS = {
  profile: { method: "xlm" as const, name: "Payout Holder", address: ADDRESS, memo: "4242", memoType: "id" as const },
  savedAt: "2026-10-01T00:00:00+00:00",
  updatedAt: "2026-10-02T00:00:00.123456+00:00",
};

describe("paying in two steps", () => {
  it("starts with exactly the rewards, total and details version the row showed", () => {
    expect(payoutRequest(row())).toEqual({
      referrerId: "00000000-0000-4000-8000-0000000000c3",
      rewardIds: ["00000000-0000-4000-8000-0000000000d4", "00000000-0000-4000-8000-0000000000d5"],
      amountPhp: 75,
      detailsUpdatedAt: "2026-10-02T00:00:00+00:00",
    });
  });

  it("can't start without details, with nothing eligible, or while another admin is paying", () => {
    expect(payoutRequest(row({ details: null }))).toBeNull();
    expect(payoutRequest(row({ eligibleRewardIds: [], eligibleCount: 0, owedPhp: 0 }))).toBeNull();
    const claim = { by: "other@example.com", since: "2026-11-07T10:00:00Z", expiresAt: "2026-11-07T12:00:00Z" };
    expect(payoutRequest(row({ claim: { ...claim, mine: false } }))).toBeNull();
    expect(payoutRequest(row({ claim: { ...claim, mine: true } }))).not.toBeNull();
  });

  it("posts start, uncached, and records with the version the database confirmed", async () => {
    const fetchSpy = mockFetch(200, {
      started: { details: STARTED_DETAILS, claimedAt: "2026-11-07T10:00:00Z", expiresAt: "2026-11-07T12:00:00Z" },
    });
    const started = await startPayout(payoutRequest(row())!);
    expect(started.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(PAYOUTS_ROUTE);
    expect(init).toMatchObject({ method: "POST", cache: "no-store" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ action: "start", amountPhp: 75 });
    if (!started.ok) return;
    expect(started.value.details.profile).toEqual(STARTED_DETAILS.profile);
    expect(markPaidRequest(started.value, "  tx-hash ")).toEqual({
      referrerId: "00000000-0000-4000-8000-0000000000c3",
      rewardIds: ["00000000-0000-4000-8000-0000000000d4", "00000000-0000-4000-8000-0000000000d5"],
      amountPhp: 75,
      detailsUpdatedAt: "2026-10-02T00:00:00.123456+00:00",
      reference: "tx-hash",
    });
    expect(markPaidRequest(started.value, "   ").reference).toBeNull();
  });

  it("records, and reads what was recorded", async () => {
    const fetchSpy = mockFetch(200, { payoutId: "p1", rewardCount: 2, amountPhp: 75 });
    const request = { ...payoutRequest(row())!, reference: null };
    expect(await markPaid(request)).toEqual({ ok: true, value: { payoutId: "p1", rewardCount: 2, amountPhp: 75 } });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({ action: "record" });
  });

  it("releases", async () => {
    const fetchSpy = mockFetch(200, { released: true });
    expect(await releasePayout("u1")).toEqual({ ok: true, value: true });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({ action: "release", referrerId: "u1" });
  });

  it("shows the server's refusal in its own words, or a fixed one when there are none", async () => {
    const request = { ...payoutRequest(row())!, reference: null };
    mockFetch(409, { error: "These rewards were already recorded as paid by admin@example.com." });
    expect(await markPaid(request)).toEqual({
      ok: false,
      message: "These rewards were already recorded as paid by admin@example.com.",
    });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    expect(await markPaid(request)).toEqual({
      ok: false,
      message: "The payout couldn't be confirmed. Reload to check whether it was recorded before trying again.",
    });
    expect(await startPayout(payoutRequest(row())!)).toEqual({
      ok: false,
      message: "The payout couldn't be started. Nothing is held: reload and try again.",
    });
  });
});

describe("the other calls", () => {
  it("void, restore and limit go to their routes", async () => {
    const fetchSpy = mockFetch(200, { status: "void" });
    expect(await voidReward("r1", "fraud")).toEqual({ ok: true, value: "void" });
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/admin/referrals/rewards/r1");
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({ action: "void", reason: "fraud" });
    vi.restoreAllMocks();
    const limitSpy = mockFetch(200, { limit: 31 });
    expect(await setLimit("u1", 31)).toEqual({ ok: true, value: 31 });
    expect(limitSpy.mock.calls[0][0]).toBe("/api/admin/referrals/referrers/u1");
  });

  it("reads the queue, and a malformed answer is a failure", async () => {
    mockFetch(200, { rows: [row()] });
    expect(await fetchQueue()).toMatchObject({ ok: true, value: [{ owedPhp: 75 }] });
    vi.restoreAllMocks();
    mockFetch(200, { nothing: true });
    expect(await fetchQueue()).toEqual({ ok: false, message: "The payout queue couldn't be loaded." });
  });
});

describe("one action at a time", () => {
  it("ignores a second press while the first is still running", async () => {
    const flight = createSingleFlight();
    let release!: () => void;
    const action = vi.fn(() => new Promise<string>((resolve) => (release = () => resolve("done"))));
    const first = flight.run(action);
    expect(flight.busy).toBe(true);
    expect(await flight.run(action)).toBeUndefined();
    release();
    expect(await first).toBe("done");
    expect(action).toHaveBeenCalledTimes(1);
    expect(flight.busy).toBe(false);
    await flight.run(async () => "again");
  });

  it("frees itself after a failure", async () => {
    const flight = createSingleFlight();
    await expect(flight.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await flight.run(async () => 1)).toBe(1);
  });
});

describe("what it says after an action", () => {
  it("names the amount, count and who", () => {
    expect(paidMessage("referrer@example.com", { payoutId: "p", rewardCount: 2, amountPhp: 75 })).toBe(
      "Recorded a payout of 75 PHP for 2 rewards to referrer@example.com. They now show as Paid.",
    );
    expect(restoreMessage("a@example.com", "over_limit")).toContain("over the limit");
  });

  it("says what a new limit moved, and that lowering demotes nothing", () => {
    const before = row({ eligibleCount: 30, overLimitCount: 2 });
    expect(limitMessage("r", 31, before, row({ eligibleCount: 31, overLimitCount: 1 }))).toBe(
      "Set r's limit to 31. 1 reward moved up from over the limit to eligible.",
    );
    expect(limitMessage("r", 5, before, before)).toBe("Set r's limit to 5. Rewards already eligible or paid stay as they are.");
  });

  it("writes dates the same on the server and in the browser", () => {
    expect(formatDay("2026-12-07T23:30:00Z")).toBe("7 Dec 2026");
    expect(formatTime("2026-12-07T14:05:00Z")).toBe("7 Dec 2026, 14:05 UTC");
    expect(formatDay(null)).toBe("—");
  });
});

describe("the panel", () => {
  const html = (rows: PayoutQueueRow[]) => renderToStaticMarkup(createElement(ReferralPayouts, { initialRows: rows }));

  it("shows an overdue row's due date, amount, counts and the details in full", () => {
    const markup = html([row()]);
    expect(markup).toContain("Overdue · due 1 Nov 2026");
    expect(markup).toContain("75 PHP");
    expect(markup).toContain(ADDRESS);
    expect(markup).toContain("4242 (ID)");
    expect(markup).toContain("30 (default)");
    expect(markup).toContain("Nothing is sent automatically.");
    expect(markup).toContain("paste the transaction hash as the reference");
  });

  it("shows Waiting for details, with Mark as paid unavailable", () => {
    const markup = html([row({ details: null, due: { state: "waiting_for_details" } })]);
    expect(markup).toContain("Waiting for details");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*data-testid="payout-start"/);
  });

  it("shows an e-wallet's account in full", () => {
    const markup = html([
      row({
        details: {
          profile: {
            method: "ewallet",
            name: "Payout Holder",
            provider: "Maya",
            accountName: "Account Holder",
            accountNumber: "0917 555 0101",
            details: "Main branch",
          },
          savedAt: "2026-10-01T00:00:00+00:00",
          updatedAt: "2026-10-01T00:00:00+00:00",
        },
      }),
    ]);
    expect(markup).toContain("0917 555 0101");
    expect(markup).toContain("Main branch");
    expect(markup).toContain("E-wallet or bank · Maya");
  });

  it("says who is paying, and holds Start payout back for everyone else", () => {
    const claim = { by: "other@example.com", since: "2026-11-07T10:00:00Z", expiresAt: "2026-11-07T12:00:00Z" };
    const theirs = html([row({ claim: { ...claim, mine: false } })]);
    expect(theirs).toContain("Being paid by");
    expect(theirs).toContain("other@example.com");
    expect(theirs).toContain("since 7 Nov 2026, 10:00 UTC");
    expect(theirs).toMatch(/<button[^>]*disabled[^>]*data-testid="payout-start"/);
    const mine = html([row({ claim: { ...claim, mine: true } })]);
    expect(mine).toContain("You started this payout at 7 Nov 2026, 10:00 UTC");
    expect(mine).toContain("Continue payout");
    expect(mine).toContain('data-testid="payout-release"');
  });

  it("says when nobody is owed anything", () => {
    expect(html([])).toContain("Nobody is owed anything");
  });
});
