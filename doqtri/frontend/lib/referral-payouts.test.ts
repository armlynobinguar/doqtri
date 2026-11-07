import { describe, expect, it } from "vitest";
import {
  MARK_PAID_MAX_REWARDS,
  PAYOUT_AMOUNT_MAX,
  REWARD_LIMIT_MAX,
  alreadyPaidMessage,
  amountOwed,
  busyMessage,
  checkLimit,
  checkMarkPaid,
  checkPayoutRequest,
  checkReference,
  checkRewardAction,
  checkVoidReason,
  isUuid,
  payoutDestination,
  payoutDue,
  payoutQueueRow,
  payoutReferralRow,
  sortPayoutQueue,
  type PayoutQueueRecord,
  type PayoutReferralRecord,
} from "@/lib/referral-payouts";
import { REFERRAL_REWARD_LIMIT } from "@/lib/referral-program";

/**
 * The payouts panel's rules (WP-4.6, DOQ-26): the due date (DOQ-26's comment from
 * DOQ-29), the amount owed (AC 2), the queue's order, and what the routes accept.
 */

const DAY = 24 * 60 * 60_000;
const at = (iso: string) => Date.parse(iso);
const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";
const ADDRESS = `G${"A".repeat(55)}`;

function record(overrides: Partial<PayoutQueueRecord> = {}): PayoutQueueRecord {
  return {
    referrer_user_id: ID_A,
    email: "referrer@example.com",
    g_wallet: null,
    eligible_rewards: [],
    over_limit_count: 0,
    paid_count: 0,
    void_count: 0,
    reward_limit: null,
    method: "xlm",
    name: "Payout Holder",
    xlm_address: ADDRESS,
    xlm_memo: "4242",
    xlm_memo_type: "id",
    ewallet_provider: null,
    ewallet_account_name: null,
    ewallet_account_number: null,
    ewallet_details: null,
    details_created_at: "2026-11-01T00:00:00.000Z",
    details_updated_at: "2026-11-01T00:00:00.000Z",
    claim_admin_id: null,
    claim_admin_email: null,
    claim_admin_wallet: null,
    claimed_at: null,
    claim_expires_at: null,
    ...overrides,
  };
}

describe("the due date", () => {
  it("counts 30 days from qualifying when the details were saved before", () => {
    const due = payoutDue("2026-11-05T10:00:00.000Z", "2026-11-01T00:00:00.000Z", at("2026-11-06T00:00:00Z"));
    expect(due).toEqual({ state: "due", dueAt: "2026-12-05T10:00:00.000Z", overdue: false });
  });

  it("counts 30 days from the questionnaire when it came after qualifying", () => {
    const due = payoutDue("2026-11-01T00:00:00.000Z", "2026-11-20T08:30:00.000Z", at("2026-11-21T00:00:00Z"));
    expect(due).toEqual({ state: "due", dueAt: "2026-12-20T08:30:00.000Z", overdue: false });
  });

  it("is overdue only once the moment has passed", () => {
    const qualified = "2026-10-01T00:00:00.000Z";
    const deadline = at(qualified) + 30 * DAY;
    expect(payoutDue(qualified, "2026-09-01T00:00:00Z", deadline)).toMatchObject({ overdue: false });
    expect(payoutDue(qualified, "2026-09-01T00:00:00Z", deadline + 1)).toMatchObject({ overdue: true });
  });

  it("waits for details when there are none, and has nothing to count when nothing is eligible", () => {
    expect(payoutDue("2026-11-01T00:00:00Z", null, Date.now())).toEqual({ state: "waiting_for_details" });
    expect(payoutDue(null, "2026-11-01T00:00:00Z", Date.now())).toEqual({ state: "nothing_owed" });
  });

  it("follows the earliest eligible reward, whatever order they arrive in", () => {
    const row = payoutQueueRow(
      record({
        eligible_rewards: [
          { id: ID_B, amount_php: 30, qualified_at: "2026-11-10T00:00:00.000Z" },
          { id: ID_A, amount_php: 30, qualified_at: "2026-11-03T00:00:00.000Z" },
        ],
      }),
      at("2026-11-11T00:00:00Z"),
    );
    expect(row.due).toEqual({ state: "due", dueAt: "2026-12-03T00:00:00.000Z", overdue: false });
    expect(row.eligibleRewardIds).toEqual([ID_A, ID_B]);
  });

  it("isn't moved by an edit: it counts from when the details were first saved, not last changed", () => {
    const eligible = [{ id: ID_A, amount_php: 30, qualified_at: "2026-10-01T00:00:00.000Z" }];
    const now = at("2026-11-05T00:00:00Z");
    const saved = { details_created_at: "2026-09-15T00:00:00.000Z", details_updated_at: "2026-09-15T00:00:00.000Z" };
    const before = payoutQueueRow(record({ eligible_rewards: eligible, ...saved }), now);
    const edited = payoutQueueRow(
      record({ eligible_rewards: eligible, ...saved, details_updated_at: "2026-11-04T00:00:00.000Z" }),
      now,
    );
    expect(edited.due).toEqual(before.due);
    expect(edited.due).toEqual({ state: "due", dueAt: "2026-10-31T00:00:00.000Z", overdue: true });
    expect(edited.details?.updatedAt).toBe("2026-11-04T00:00:00.000Z");
  });

  it("marks a row overdue in the queue", () => {
    const row = payoutQueueRow(
      record({
        eligible_rewards: [{ id: ID_A, amount_php: 30, qualified_at: "2026-09-01T00:00:00.000Z" }],
        details_created_at: "2026-08-01T00:00:00.000Z",
      }),
      at("2026-11-07T00:00:00Z"),
    );
    expect(row.due).toMatchObject({ state: "due", overdue: true });
  });
});

describe("the amount owed (AC 2)", () => {
  it("adds each eligible reward's stored amount, not a constant times the count", () => {
    expect(amountOwed([{ amount_php: 30 }, { amount_php: 45 }, { amount_php: 30 }])).toBe(105);
    expect(amountOwed([])).toBe(0);
  });

  it("counts only the eligible rewards the queue lists: over limit and paid are counts alone", () => {
    const row = payoutQueueRow(
      record({
        eligible_rewards: [
          { id: ID_A, amount_php: 30, qualified_at: "2026-11-01T00:00:00Z" },
          { id: ID_B, amount_php: 45, qualified_at: "2026-11-02T00:00:00Z" },
        ],
        over_limit_count: 4,
        paid_count: 7,
      }),
      Date.now(),
    );
    expect(row).toMatchObject({ owedPhp: 75, eligibleCount: 2, overLimitCount: 4, paidCount: 7 });
  });

  it("is nothing for a referrer with only over-limit rewards", () => {
    const row = payoutQueueRow(record({ eligible_rewards: null, over_limit_count: 2 }), Date.now());
    expect(row).toMatchObject({ owedPhp: 0, eligibleCount: 0, due: { state: "nothing_owed" } });
  });
});

describe("a queue row", () => {
  it("names a wallet login by its wallet, and an email account by its email", () => {
    const wallet = `G${"B".repeat(55)}`;
    expect(payoutQueueRow(record({ email: `${wallet.toLowerCase()}@stellar.doqtri.local` }), 0).identity).toBe(wallet);
    expect(payoutQueueRow(record(), 0).identity).toBe("referrer@example.com");
  });

  it("uses the referrer's own limit, or the default from lib/referral-program.ts", () => {
    expect(payoutQueueRow(record(), 0)).toMatchObject({ limit: REFERRAL_REWARD_LIMIT, limitRaised: false });
    expect(payoutQueueRow(record({ reward_limit: 31 }), 0)).toMatchObject({ limit: 31, limitRaised: true });
  });

  it("says who is paying, and whether it's the admin looking", () => {
    const held = record({
      claim_admin_id: ID_B,
      claim_admin_email: "admin@example.com",
      claimed_at: "2026-11-07T10:00:00Z",
      claim_expires_at: "2026-11-07T12:00:00Z",
    });
    expect(payoutQueueRow(held, 0, ID_B).claim).toEqual({
      by: "admin@example.com",
      since: "2026-11-07T10:00:00Z",
      expiresAt: "2026-11-07T12:00:00Z",
      mine: true,
    });
    expect(payoutQueueRow(held, 0, ID_A).claim?.mine).toBe(false);
    expect(payoutQueueRow(record(), 0, ID_A).claim).toBeNull();
  });

  it("carries the details in full, or none while there are none", () => {
    expect(payoutQueueRow(record(), 0).details?.profile).toEqual({
      method: "xlm",
      name: "Payout Holder",
      address: ADDRESS,
      memo: "4242",
      memoType: "id",
    });
    expect(payoutQueueRow(record({ method: null, name: null, details_created_at: null }), 0).details).toBeNull();
  });

  it("writes the destination out in full for the confirm dialog", () => {
    expect(payoutDestination({ method: "xlm", name: "N", address: ADDRESS, memo: "4242", memoType: "id" })).toBe(
      `XLM to ${ADDRESS}, ID memo 4242`,
    );
    expect(payoutDestination({ method: "xlm", name: "N", address: ADDRESS, memo: null, memoType: null })).toBe(
      `XLM to ${ADDRESS}, no memo`,
    );
    expect(
      payoutDestination({
        method: "ewallet",
        name: "N",
        provider: "GCash",
        accountName: "Account Holder",
        accountNumber: "0917 555 0101",
        details: null,
      }),
    ).toBe("GCash 0917 555 0101 (Account Holder)");
  });
});

describe("the queue's order", () => {
  it("is by due date, so overdue rows lead, then waiting for details, then nothing owed", () => {
    const now = at("2026-11-07T00:00:00Z");
    const row = (email: string, qualified: string | null, saved: string | null) =>
      payoutQueueRow(
        record({
          email,
          referrer_user_id: email,
          eligible_rewards: qualified ? [{ id: email, amount_php: 30, qualified_at: qualified }] : [],
          over_limit_count: qualified ? 0 : 1,
          method: saved ? "xlm" : null,
          details_created_at: saved,
        }),
        now,
      );
    const sorted = sortPayoutQueue([
      row("later@example.com", "2026-11-06T00:00:00Z", "2026-11-01T00:00:00Z"),
      row("over@example.com", null, "2026-11-01T00:00:00Z"),
      row("waiting@example.com", "2026-09-01T00:00:00Z", null),
      row("overdue@example.com", "2026-09-15T00:00:00Z", "2026-09-01T00:00:00Z"),
      row("sooner@example.com", "2026-10-20T00:00:00Z", "2026-09-01T00:00:00Z"),
    ]);
    expect(sorted.map((r) => r.identity)).toEqual([
      "overdue@example.com",
      "sooner@example.com",
      "later@example.com",
      "waiting@example.com",
      "over@example.com",
    ]);
    expect(sorted[0].due).toMatchObject({ overdue: true });
  });
});

describe("a referred account for review", () => {
  const base: PayoutReferralRecord = {
    reward_id: ID_A,
    email: "referred@example.com",
    g_wallet: null,
    c_wallet: `C${"C".repeat(55)}`,
    referred_wallet: `C${"C".repeat(55)}`,
    signed_up_at: "2026-11-01T00:00:00Z",
    referred_at: "2026-11-01T00:00:01Z",
    source: "link",
    network: "testnet",
    activity_count: 5,
    qualified_at: "2026-11-02T00:00:00Z",
    reward_status: "eligible",
    void_reason: null,
    amount_php: 30,
    former_user: false,
  };

  it("is shown in full, its wallets once each", () => {
    expect(payoutReferralRow(base)).toMatchObject({
      identity: "referred@example.com",
      wallets: [`C${"C".repeat(55)}`],
      activity: 5,
      status: "eligible",
      canVoid: true,
      canRestore: false,
    });
  });

  it("can be restored from void, unless the database voided it", () => {
    expect(payoutReferralRow({ ...base, reward_status: "void", void_reason: "fraud" })).toMatchObject({
      canVoid: false,
      canRestore: true,
    });
    for (const reason of ["duplicate_wallet", "referrer_deleted"]) {
      expect(payoutReferralRow({ ...base, reward_status: "void", void_reason: reason }).canRestore).toBe(false);
    }
  });

  it("is pending with no reward, and neither voids nor restores", () => {
    expect(payoutReferralRow({ ...base, reward_id: null, reward_status: null })).toMatchObject({
      status: "pending",
      canVoid: false,
      canRestore: false,
    });
  });

  it("is a Former user with no activity once deleted", () => {
    expect(
      payoutReferralRow({ ...base, email: null, c_wallet: null, former_user: true, activity_count: null }),
    ).toMatchObject({ identity: "Former user", activity: null, wallets: [`C${"C".repeat(55)}`] });
  });
});

describe("what the routes accept", () => {
  it("knows a uuid", () => {
    expect(isUuid(ID_A)).toBe(true);
    for (const bad of ["", "abc", `${ID_A}x`, "../etc", 7, null]) expect(isUuid(bad)).toBe(false);
  });

  it("needs a void reason, in plain text, of the admin's own", () => {
    expect(checkVoidReason("  farmed accounts  ")).toEqual({ ok: true, reason: "farmed accounts" });
    for (const bad of [undefined, "", "   ", "a\nb", "zero\u200bwidth", "x".repeat(201), "duplicate_wallet", "Referrer_Deleted"]) {
      expect(checkVoidReason(bad).ok).toBe(false);
    }
  });

  it("takes an optional reference, trimmed, with blank as none", () => {
    expect(checkReference(undefined)).toEqual({ ok: true, reference: null });
    expect(checkReference("   ")).toEqual({ ok: true, reference: null });
    expect(checkReference("  abc123  ")).toEqual({ ok: true, reference: "abc123" });
    expect(checkReference("a".repeat(100)).ok).toBe(true);
    for (const bad of ["a".repeat(101), "tab\there", "rtl\u202emark", 42]) expect(checkReference(bad).ok).toBe(false);
  });

  it("takes a limit from 0 to 10,000, whole", () => {
    expect(checkLimit(31)).toEqual({ ok: true, limit: 31 });
    expect(checkLimit("0")).toEqual({ ok: true, limit: 0 });
    expect(checkLimit(REWARD_LIMIT_MAX)).toEqual({ ok: true, limit: 1000 });
    for (const bad of [-1, 1.5, 1001, 10_000, "", "abc", null, undefined]) expect(checkLimit(bad).ok).toBe(false);
  });

  it("keeps a limit and a payout's size the same, so every eligible reward fits in one payout", () => {
    expect(MARK_PAID_MAX_REWARDS).toBe(REWARD_LIMIT_MAX);
  });

  it("takes exactly what Mark as paid needs", () => {
    const good = { referrerId: ID_A, rewardIds: [ID_B], amountPhp: 30, detailsUpdatedAt: "2026-11-01T00:00:00+00:00" };
    expect(checkMarkPaid({ ...good, reference: " hash " })).toEqual({
      ok: true,
      request: { ...good, reference: "hash" },
    });
    for (const bad of [
      { ...good, referrerId: "nope" },
      { ...good, rewardIds: [] },
      { ...good, rewardIds: [ID_B, ID_B] },
      { ...good, rewardIds: ["nope"] },
      { ...good, amountPhp: 0 },
      { ...good, amountPhp: 30.5 },
      { ...good, amountPhp: "30" },
      { ...good, detailsUpdatedAt: "yesterday" },
      { ...good, reference: "x".repeat(101) },
      null,
    ]) {
      expect(checkMarkPaid(bad).ok).toBe(false);
    }
  });

  it("bounds a payout to what the database holds: an int4 amount, and a limit's worth of rewards", () => {
    const good = { referrerId: ID_A, rewardIds: [ID_B], amountPhp: PAYOUT_AMOUNT_MAX, detailsUpdatedAt: "2026-11-01T00:00:00Z" };
    expect(checkPayoutRequest(good).ok).toBe(true);
    expect(checkPayoutRequest({ ...good, amountPhp: 2 ** 31 }).ok).toBe(false);
    const many = Array.from({ length: MARK_PAID_MAX_REWARDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(checkPayoutRequest({ ...good, rewardIds: many }).ok).toBe(false);
    expect(checkPayoutRequest({ ...good, rewardIds: many.slice(1) }).ok).toBe(true);
    // Start takes no reference; record does, and checks it.
    expect(checkMarkPaid({ ...good, reference: "a\nb" }).ok).toBe(false);
  });

  it("takes void with a reason, or restore", () => {
    expect(checkRewardAction({ action: "restore" })).toEqual({ ok: true, change: { action: "restore" } });
    expect(checkRewardAction({ action: "void", reason: "fraud" })).toEqual({
      ok: true,
      change: { action: "void", reason: "fraud" },
    });
    expect(checkRewardAction({ action: "void" }).ok).toBe(false);
    expect(checkRewardAction({ action: "pay" }).ok).toBe(false);
  });
});

describe("what a refused payout says", () => {
  it("says the rewards were already paid, by whom, when and how much, and to reconcile", () => {
    expect(
      alreadyPaidMessage([{ by: "admin@example.com", paidAt: "2026-11-07T14:05:00Z", amountPhp: 60, rewardCount: 2 }]),
    ).toBe(
      "These rewards were already recorded as paid by admin@example.com on 7 Nov 2026, 14:05 UTC (2 rewards, 60 PHP). " +
        "Nothing more was recorded. If you also sent money for them, reconcile with the referrer before paying again.",
    );
  });

  it("says who is paying, since when, and not to send anything", () => {
    expect(
      busyMessage({ by: "other@example.com", since: "2026-11-07T10:00:00Z", expiresAt: "2026-11-07T12:00:00Z" }),
    ).toBe(
      "Being paid by other@example.com since 7 Nov 2026, 10:00 UTC. Don't send anything: wait for them to record it, " +
        "or for their hold to end at 7 Nov 2026, 12:00 UTC.",
    );
  });
});
