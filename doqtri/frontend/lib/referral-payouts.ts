/**
 * The admin payouts panel's rules (WP-4.6, DOQ-26, D-110, D-112): what a referrer
 * is owed, when it's due, how the queue sorts, and what the routes accept. Safe in
 * the browser; the server's reads and writes are in lib/referral-payouts-store.ts,
 * over backend/migrations/20261107130000_referral_payouts.sql.
 *
 * Nothing here or anywhere in the panel sends money: admins pay by hand, then
 * record it.
 */
import { FORMER_USER } from "@/lib/former-user";
import type { PayoutMemoType, PayoutProfile, PayoutProvider } from "@/lib/referral-payout";
import { REFERRAL_REWARD_LIMIT } from "@/lib/referral-program";
import { walletAddressFromEmail } from "@/lib/wallet-address";

/** DOQ-29's commitment: paid within 30 days of eligibility and a complete questionnaire. */
export const PAYOUT_DUE_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** One eligible reward, as referral_payout_queue() lists it. */
export type EligibleReward = { id: string; amount_php: number; qualified_at: string };

/** What referral_payout_queue() returns: payout details in full, so server-only until shaped. */
export type PayoutQueueRecord = {
  referrer_user_id: string;
  email: string | null;
  g_wallet: string | null;
  eligible_rewards: EligibleReward[] | null;
  over_limit_count: number;
  paid_count: number;
  /** Void rewards an admin can restore: not duplicate_wallet. */
  void_count: number;
  reward_limit: number | null;
  method: "xlm" | "ewallet" | null;
  name: string | null;
  xlm_address: string | null;
  xlm_memo: string | null;
  xlm_memo_type: PayoutMemoType | null;
  ewallet_provider: PayoutProvider | null;
  ewallet_account_name: string | null;
  ewallet_account_number: string | null;
  ewallet_details: string | null;
  details_created_at: string | null;
  details_updated_at: string | null;
};

export type PayoutDue =
  /** Something eligible, and details saved: due 30 days from the later of the two. */
  | { state: "due"; dueAt: string; overdue: boolean }
  /** Something eligible, and no details yet: the clock hasn't started, and it can't be paid. */
  | { state: "waiting_for_details" }
  /** Only over-limit or void rewards: nothing to pay. */
  | { state: "nothing_owed" };

/** Full details, with when they were first saved and last edited. */
export type PayoutDetails = { profile: PayoutProfile; savedAt: string; updatedAt: string };

export type PayoutQueueRow = {
  referrerId: string;
  /** Email, or the wallet for a wallet login. */
  identity: string;
  /** Exactly what Mark as paid sends back, so nothing that changed since gets paid. */
  eligibleRewardIds: string[];
  eligibleCount: number;
  overLimitCount: number;
  paidCount: number;
  voidCount: number;
  owedPhp: number;
  limit: number;
  /** An admin set this referrer's limit; otherwise it's the default. */
  limitRaised: boolean;
  details: PayoutDetails | null;
  due: PayoutDue;
};

/** The sum of each eligible reward's stored amount: what it was worth when it qualified, not today's rate. */
export function amountOwed(rewards: readonly Pick<EligibleReward, "amount_php">[]): number {
  return rewards.reduce((sum, reward) => sum + reward.amount_php, 0);
}

/**
 * Due 30 days after the earliest unpaid eligible reward qualified or the details
 * were first saved, whichever is later. `detailsSavedAt` is when they were first
 * saved, never last edited: an edit doesn't move a due date.
 */
export function payoutDue(earliestQualifiedAt: string | null, detailsSavedAt: string | null, now: number): PayoutDue {
  if (!earliestQualifiedAt) return { state: "nothing_owed" };
  if (!detailsSavedAt) return { state: "waiting_for_details" };
  const due = Math.max(Date.parse(earliestQualifiedAt), Date.parse(detailsSavedAt)) + PAYOUT_DUE_DAYS * DAY_MS;
  return { state: "due", dueAt: new Date(due).toISOString(), overdue: now > due };
}

/** Email, or the wallet behind a wallet login's synthetic one, or the wallet linked, or the id. */
export function accountIdentity(email: string | null, wallet: string | null, id: string): string {
  return walletAddressFromEmail(email) ?? email ?? wallet ?? id;
}

export function payoutDetails(record: PayoutQueueRecord): PayoutDetails | null {
  if (!record.method || !record.name || !record.details_created_at || !record.details_updated_at) return null;
  const profile: PayoutProfile =
    record.method === "xlm"
      ? { method: "xlm", name: record.name, address: record.xlm_address ?? "", memo: record.xlm_memo, memoType: record.xlm_memo_type }
      : {
          method: "ewallet",
          name: record.name,
          provider: record.ewallet_provider ?? "Other",
          accountName: record.ewallet_account_name ?? "",
          accountNumber: record.ewallet_account_number ?? "",
          details: record.ewallet_details,
        };
  return { profile, savedAt: record.details_created_at, updatedAt: record.details_updated_at };
}

export function payoutQueueRow(record: PayoutQueueRecord, now: number): PayoutQueueRow {
  const eligible = [...(record.eligible_rewards ?? [])].sort(
    (a, b) => Date.parse(a.qualified_at) - Date.parse(b.qualified_at) || a.id.localeCompare(b.id),
  );
  const details = payoutDetails(record);
  return {
    referrerId: record.referrer_user_id,
    identity: accountIdentity(record.email, record.g_wallet, record.referrer_user_id),
    eligibleRewardIds: eligible.map((reward) => reward.id),
    eligibleCount: eligible.length,
    overLimitCount: record.over_limit_count,
    paidCount: record.paid_count,
    voidCount: record.void_count ?? 0,
    owedPhp: amountOwed(eligible),
    limit: record.reward_limit ?? REFERRAL_REWARD_LIMIT,
    limitRaised: record.reward_limit !== null,
    details,
    due: payoutDue(eligible[0]?.qualified_at ?? null, details?.savedAt ?? null, now),
  };
}

const DUE_ORDER: Record<PayoutDue["state"], number> = { due: 0, waiting_for_details: 1, nothing_owed: 2 };

/**
 * By due date, earliest first, so overdue rows lead; then those waiting for
 * details, then those with only over-limit or void rewards. Ties by identity.
 */
export function sortPayoutQueue(rows: readonly PayoutQueueRow[]): PayoutQueueRow[] {
  return [...rows].sort((a, b) => {
    const byState = DUE_ORDER[a.due.state] - DUE_ORDER[b.due.state];
    if (byState) return byState;
    if (a.due.state === "due" && b.due.state === "due") {
      const byDate = Date.parse(a.due.dueAt) - Date.parse(b.due.dueAt);
      if (byDate) return byDate;
    }
    return a.identity.localeCompare(b.identity);
  });
}

/** Where the money goes, in full, for the confirm dialog: the admin copies from it. */
export function payoutDestination(profile: PayoutProfile): string {
  if (profile.method === "xlm") {
    const memo = profile.memo ? `, ${profile.memoType === "id" ? "ID" : "text"} memo ${profile.memo}` : ", no memo";
    return `XLM to ${profile.address}${memo}`;
  }
  return `${profile.provider} ${profile.accountNumber} (${profile.accountName})`;
}

// ---------------------------------------------------------------------------
// The review list
// ---------------------------------------------------------------------------

/** What referral_payout_referrals() returns. */
export type PayoutReferralRecord = {
  reward_id: string | null;
  email: string | null;
  g_wallet: string | null;
  c_wallet: string | null;
  referred_wallet: string | null;
  signed_up_at: string | null;
  referred_at: string | null;
  source: string | null;
  network: string | null;
  activity_count: number | null;
  qualified_at: string | null;
  reward_status: string | null;
  void_reason: string | null;
  amount_php: number | null;
  former_user: boolean;
};

export type RewardStatus = "pending" | "eligible" | "over_limit" | "paid" | "void";

/** Void reasons the database gives, never an admin: neither can be restored. */
export const SYSTEM_VOID_REASONS = ["duplicate_wallet", "referrer_deleted"] as const;

export type PayoutReferralRow = {
  /** Null while the referral hasn't qualified. */
  rewardId: string | null;
  identity: string;
  former: boolean;
  /** Every wallet known for the account, in full, without repeats. */
  wallets: string[];
  signedUpAt: string | null;
  referredAt: string | null;
  network: string | null;
  /** Null for a former user, whose activity went with the account. */
  activity: number | null;
  qualifiedAt: string | null;
  status: RewardStatus;
  voidReason: string | null;
  amountPhp: number | null;
  canVoid: boolean;
  canRestore: boolean;
};

function rewardStatus(status: string | null): RewardStatus {
  return status === "eligible" || status === "over_limit" || status === "paid" || status === "void" ? status : "pending";
}

export function payoutReferralRow(record: PayoutReferralRecord): PayoutReferralRow {
  const status = rewardStatus(record.reward_status);
  const wallets = [walletAddressFromEmail(record.email), record.g_wallet, record.c_wallet, record.referred_wallet].filter(
    (wallet, index, all): wallet is string => Boolean(wallet) && all.indexOf(wallet) === index,
  );
  const restorable =
    status === "void" && !SYSTEM_VOID_REASONS.some((reason) => reason === record.void_reason);
  return {
    rewardId: record.reward_id,
    identity: record.former_user
      ? FORMER_USER
      : (walletAddressFromEmail(record.email) ?? record.email ?? wallets[0] ?? "Unknown account"),
    former: record.former_user,
    wallets,
    signedUpAt: record.signed_up_at,
    referredAt: record.referred_at,
    network: record.network,
    activity: record.former_user ? null : (record.activity_count ?? 0),
    qualifiedAt: record.qualified_at,
    status,
    voidReason: record.void_reason,
    amountPhp: record.amount_php,
    canVoid: Boolean(record.reward_id) && (status === "eligible" || status === "over_limit"),
    canRestore: Boolean(record.reward_id) && restorable,
  };
}

// ---------------------------------------------------------------------------
// What the routes accept
// ---------------------------------------------------------------------------

/**
 * No control or format character (line breaks, zero-width spaces, reordering
 * marks, byte order marks), line or paragraph separator, lone surrogate, or blank
 * filler: each could make what's shown differ from what's stored. The database
 * checks a reference with referral_payout_text_ok() as well.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u115f\u1160\u2800\u3164\uffa0]/u;

export const VOID_REASON_MAX = 200;
export const PAYOUT_REFERENCE_MAX = 100;
export const REWARD_LIMIT_MAX = 10_000;
/** More rewards than one referrer could be owed at once under any sane limit. */
export const MARK_PAID_MAX_REWARDS = 1000;

export type Checked<T> = ({ ok: true } & T) | { ok: false; error: string };

function characters(text: string): number {
  return Array.from(text).length;
}

export function checkVoidReason(input: unknown): Checked<{ reason: string }> {
  const reason = typeof input === "string" ? input.trim() : "";
  if (!reason) return { ok: false, error: "Give a reason for voiding this reward." };
  if (INVISIBLE.test(reason)) return { ok: false, error: "Remove the line breaks or special characters from the reason." };
  if (characters(reason) > VOID_REASON_MAX) {
    return { ok: false, error: `Keep the reason to ${VOID_REASON_MAX} characters or fewer.` };
  }
  if (SYSTEM_VOID_REASONS.some((reserved) => reserved === reason.toLowerCase())) {
    return { ok: false, error: "That reason is reserved for the system. Describe why in your own words." };
  }
  return { ok: true, reason };
}

/** Optional: a transaction hash or an e-wallet reference number. Blank is none. */
export function checkReference(input: unknown): Checked<{ reference: string | null }> {
  if (input === undefined || input === null) return { ok: true, reference: null };
  if (typeof input !== "string") return { ok: false, error: "Enter the reference as text." };
  const reference = input.trim();
  if (!reference) return { ok: true, reference: null };
  if (INVISIBLE.test(reference)) {
    return { ok: false, error: "Remove the line breaks or special characters from the reference." };
  }
  if (characters(reference) > PAYOUT_REFERENCE_MAX) {
    return { ok: false, error: `Keep the reference to ${PAYOUT_REFERENCE_MAX} characters or fewer.` };
  }
  return { ok: true, reference };
}

export function checkLimit(input: unknown): Checked<{ limit: number }> {
  const limit = typeof input === "string" && input.trim() !== "" ? Number(input) : input;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 || limit > REWARD_LIMIT_MAX) {
    return { ok: false, error: `Enter a whole number from 0 to ${REWARD_LIMIT_MAX}.` };
  }
  return { ok: true, limit };
}

export type MarkPaidRequest = {
  referrerId: string;
  rewardIds: string[];
  amountPhp: number;
  /** The details' updated_at as the admin saw them, passed back untouched. */
  detailsUpdatedAt: string;
  reference: string | null;
};

export function checkMarkPaid(input: unknown): Checked<{ request: MarkPaidRequest }> {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const invalid = { ok: false as const, error: "Reload the page and try again." };
  if (!isUuid(raw.referrerId)) return invalid;
  const ids = raw.rewardIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MARK_PAID_MAX_REWARDS || !ids.every(isUuid)) return invalid;
  if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) return invalid;
  const amount = raw.amountPhp;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) return invalid;
  const seen = raw.detailsUpdatedAt;
  if (typeof seen !== "string" || seen.length > 64 || Number.isNaN(Date.parse(seen))) return invalid;
  const reference = checkReference(raw.reference);
  if (!reference.ok) return reference;
  return {
    ok: true,
    request: { referrerId: raw.referrerId, rewardIds: ids, amountPhp: amount, detailsUpdatedAt: seen, reference: reference.reference },
  };
}

export type RewardAction = { action: "void"; reason: string } | { action: "restore" };

export function checkRewardAction(input: unknown): Checked<{ change: RewardAction }> {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (raw.action === "restore") return { ok: true, change: { action: "restore" } };
  if (raw.action === "void") {
    const reason = checkVoidReason(raw.reason);
    return reason.ok ? { ok: true, change: { action: "void", reason: reason.reason } } : reason;
  }
  return { ok: false, error: "Choose to void or restore the reward." };
}
