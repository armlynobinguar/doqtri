import type { MarkPaidRequest, PayoutQueueRow, PayoutReferralRow, RewardStatus } from "@/lib/referral-payouts";

/*
 * The admin payouts panel's logic (WP-4.6, DOQ-26), apart from React so that it
 * can be tested without a DOM, which the unit tests don't have:
 * components/admin/referral-payouts.tsx draws it.
 */

export const PAYOUTS_ROUTE = "/api/admin/referrals/payouts";

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** The server's own words when it has some, else `fallback`. Never from a cache. */
async function call<T>(
  url: string,
  init: RequestInit,
  fallback: string,
  pick: (body: Record<string, unknown>) => T | undefined,
): Promise<Outcome<T>> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const value = res.ok && body ? pick(body) : undefined;
    if (value === undefined) {
      return { ok: false, message: typeof body?.error === "string" && body.error ? body.error : fallback };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, message: fallback };
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function fetchQueue(): Promise<Outcome<PayoutQueueRow[]>> {
  return call(PAYOUTS_ROUTE, {}, "The payout queue couldn't be loaded.", (body) =>
    Array.isArray(body.rows) ? (body.rows as PayoutQueueRow[]) : undefined,
  );
}

export function fetchReferrals(referrerId: string): Promise<Outcome<PayoutReferralRow[]>> {
  return call(
    `${PAYOUTS_ROUTE}?referrer=${encodeURIComponent(referrerId)}`,
    {},
    "This referrer's referrals couldn't be loaded.",
    (body) => (Array.isArray(body.referrals) ? (body.referrals as PayoutReferralRow[]) : undefined),
  );
}

/**
 * Exactly what the row showed: its eligible rewards, their total and the details'
 * version. Null when it can't be paid: nothing eligible, or no details.
 */
export function markPaidRequest(row: PayoutQueueRow, reference: string): MarkPaidRequest | null {
  if (!row.details || row.eligibleRewardIds.length === 0) return null;
  return {
    referrerId: row.referrerId,
    rewardIds: row.eligibleRewardIds,
    amountPhp: row.owedPhp,
    detailsUpdatedAt: row.details.updatedAt,
    reference: reference.trim() || null,
  };
}

export type Paid = { payoutId: string; rewardCount: number; amountPhp: number };

export function markPaid(request: MarkPaidRequest): Promise<Outcome<Paid>> {
  return call(
    PAYOUTS_ROUTE,
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(request) },
    "The payout couldn't be confirmed. Reload to check whether it was recorded before trying again.",
    (body) =>
      typeof body.payoutId === "string" && typeof body.rewardCount === "number" && typeof body.amountPhp === "number"
        ? { payoutId: body.payoutId, rewardCount: body.rewardCount, amountPhp: body.amountPhp }
        : undefined,
  );
}

function rewardStatusFrom(body: Record<string, unknown>): RewardStatus | undefined {
  return body.status === "void" || body.status === "eligible" || body.status === "over_limit" ? body.status : undefined;
}

export function voidReward(rewardId: string, reason: string): Promise<Outcome<RewardStatus>> {
  return call(
    `/api/admin/referrals/rewards/${encodeURIComponent(rewardId)}`,
    { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ action: "void", reason }) },
    "The reward couldn't be voided.",
    rewardStatusFrom,
  );
}

export function restoreReward(rewardId: string): Promise<Outcome<RewardStatus>> {
  return call(
    `/api/admin/referrals/rewards/${encodeURIComponent(rewardId)}`,
    { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ action: "restore" }) },
    "The reward couldn't be restored.",
    rewardStatusFrom,
  );
}

export function setLimit(referrerId: string, limit: number): Promise<Outcome<number>> {
  return call(
    `/api/admin/referrals/referrers/${encodeURIComponent(referrerId)}`,
    { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ limit }) },
    "The limit couldn't be set.",
    (body) => (typeof body.limit === "number" ? body.limit : undefined),
  );
}

/**
 * One action at a time: a second press while the first is in flight does nothing,
 * whatever the button's disabled state has caught up with. Separate from React
 * state, which a double click can outrun.
 */
export function createSingleFlight() {
  let running = false;
  return {
    get busy() {
      return running;
    },
    async run<T>(action: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined;
      running = true;
      try {
        return await action();
      } finally {
        running = false;
      }
    },
  };
}

export function formatPhp(amount: number): string {
  return `${amount.toLocaleString("en-US")} PHP`;
}

/** `7 Dec 2026`, in UTC, the same on the server and in the browser. */
export function formatDay(iso: string | null): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  return new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** `7 Dec 2026, 14:05 UTC`: for review, where the time of day matters. */
export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const at = new Date(time);
  const clock = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${formatDay(iso)}, ${clock} UTC`;
}

function rewards(count: number): string {
  return `${count} reward${count === 1 ? "" : "s"}`;
}

export function paidMessage(identity: string, paid: Paid): string {
  return `Recorded a payout of ${formatPhp(paid.amountPhp)} for ${rewards(paid.rewardCount)} to ${identity}. They now show as Paid.`;
}

export function voidMessage(identity: string): string {
  return `Voided the reward for ${identity}. If the referrer had a reward over the limit, the oldest one took its place.`;
}

export function restoreMessage(identity: string, status: RewardStatus): string {
  return status === "eligible"
    ? `Restored the reward for ${identity}. It's eligible again.`
    : `Restored the reward for ${identity}. The referrer is at their limit, so it's over the limit for now.`;
}

/** What a new limit did, from the row before and after. */
export function limitMessage(identity: string, limit: number, before: PayoutQueueRow, after: PayoutQueueRow | undefined): string {
  const moved = after ? after.eligibleCount - before.eligibleCount : 0;
  const base = `Set ${identity}'s limit to ${limit}.`;
  if (moved > 0) return `${base} ${rewards(moved)} moved up from over the limit to eligible.`;
  if (limit < before.limit) return `${base} Rewards already eligible or paid stay as they are.`;
  return base;
}

export const STATUS_LABEL: Record<RewardStatus, string> = {
  pending: "Pending",
  eligible: "Eligible",
  over_limit: "Over limit",
  paid: "Paid",
  void: "Void",
};
