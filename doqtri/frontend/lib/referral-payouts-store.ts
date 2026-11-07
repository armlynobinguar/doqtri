/**
 * The admin payouts panel's reads and writes (server-only, WP-4.6, DOQ-26), with
 * the service role, through backend/migrations/20261107130000_referral_payouts.sql
 * and the voiding and limit functions of 20261107100000_referral_eligibility.sql.
 * The rules live in lib/referral-payouts.ts; the default limit comes from
 * lib/referral-program.ts.
 *
 * What the queue returns includes payout details in full, which are financial
 * details: they are never logged, and a failure carries PayoutsStoreError's fixed
 * text and the database's error code, never its message, which could quote a row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  payoutQueueRow,
  payoutReferralRow,
  sortPayoutQueue,
  type MarkPaidRequest,
  type PayoutQueueRecord,
  type PayoutQueueRow,
  type PayoutReferralRecord,
  type PayoutReferralRow,
} from "@/lib/referral-payouts";
import { REFERRAL_REWARD_LIMIT } from "@/lib/referral-program";

/** PostgREST returns at most 1,000 rows a request. */
const READ_SIZE = 1000;

export class PayoutsStoreError extends Error {
  constructor(
    what: string,
    readonly code: string,
  ) {
    super(`${what} (${code})`);
    this.name = "PayoutsStoreError";
  }
}

function errorCode(error: { code?: string } | null | undefined): string {
  return /^[A-Za-z0-9]{1,10}$/.test(error?.code ?? "") ? error!.code! : "unknown";
}

function storeError(what: string, error: { code?: string }): PayoutsStoreError {
  return new PayoutsStoreError(what, errorCode(error));
}

async function readAll<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { code?: string } | null }>, what: string) {
  const rows: T[] = [];
  for (let from = 0; ; from += READ_SIZE) {
    const { data, error } = await read(from, from + READ_SIZE - 1);
    if (error) throw storeError(what, error);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < READ_SIZE) return rows;
  }
}

/** Every referrer with something to act on, shaped and sorted for the panel. */
export async function loadPayoutQueue(admin: Pick<SupabaseClient, "rpc">, now = Date.now()): Promise<PayoutQueueRow[]> {
  const records = await readAll<PayoutQueueRecord>(
    (from, to) => admin.rpc("referral_payout_queue").range(from, to),
    "Reading the payout queue failed",
  );
  return sortPayoutQueue(records.map((record) => payoutQueueRow(record, now)));
}

/** Everyone `referrer` referred, in full, for review. */
export async function loadPayoutReferrals(
  admin: Pick<SupabaseClient, "rpc">,
  referrer: string,
  network: string,
): Promise<PayoutReferralRow[]> {
  const records = await readAll<PayoutReferralRecord>(
    (from, to) => admin.rpc("referral_payout_referrals", { p_referrer: referrer, p_network: network }).range(from, to),
    "Reading referrals failed",
  );
  return records.map(payoutReferralRow);
}

export type MarkPaidResult =
  | { ok: true; payoutId: string }
  | { ok: false; refusal: "stale" | "no_details" | "details_changed" | "invalid" };

/** The database's refusals, by the SQLSTATE the migration gives each. */
const MARK_REFUSALS: Record<string, Exclude<MarkPaidResult, { ok: true }>["refusal"]> = {
  DQR02: "stale",
  DQR03: "no_details",
  DQR04: "details_changed",
  "22023": "invalid",
  "23514": "invalid",
};

/** One payout of exactly the rewards the admin saw. `paidBy` comes from the admin's session. */
export async function markRewardsPaid(
  admin: Pick<SupabaseClient, "rpc">,
  request: MarkPaidRequest,
  paidBy: string,
): Promise<MarkPaidResult> {
  const { data, error } = await admin.rpc("mark_referral_rewards_paid", {
    p_referrer: request.referrerId,
    p_reward_ids: request.rewardIds,
    p_amount_php: request.amountPhp,
    p_details_updated_at: request.detailsUpdatedAt,
    p_reference: request.reference,
    p_paid_by: paidBy,
  });
  if (error) {
    const refusal = MARK_REFUSALS[errorCode(error)];
    if (refusal) return { ok: false, refusal };
    throw storeError("Recording the payout failed", error);
  }
  return { ok: true, payoutId: String(data) };
}

/** False when there's no such reward, or it's paid or already void. */
export async function voidReward(admin: Pick<SupabaseClient, "rpc">, rewardId: string, reason: string): Promise<boolean> {
  const { data, error } = await admin.rpc("void_referral_reward", {
    p_reward_id: rewardId,
    p_reason: reason,
    p_default_limit: REFERRAL_REWARD_LIMIT,
  });
  if (error) throw storeError("Voiding the reward failed", error);
  return data === true;
}

export type RestoreResult = "eligible" | "over_limit" | "not_void" | "refused";

export async function restoreReward(admin: Pick<SupabaseClient, "rpc">, rewardId: string): Promise<RestoreResult> {
  const { data, error } = await admin.rpc("restore_referral_reward", {
    p_reward_id: rewardId,
    p_default_limit: REFERRAL_REWARD_LIMIT,
  });
  if (error) {
    if (errorCode(error) === "DQR05") return "refused";
    throw storeError("Restoring the reward failed", error);
  }
  return data === "eligible" || data === "over_limit" ? data : "not_void";
}

/** Raising promotes the oldest over-limit rewards; lowering demotes nothing. False when there's no such user. */
export async function setRewardLimit(admin: Pick<SupabaseClient, "rpc">, userId: string, limit: number): Promise<boolean> {
  const { error } = await admin.rpc("set_referral_reward_limit", {
    p_user_id: userId,
    p_limit: limit,
    p_default_limit: REFERRAL_REWARD_LIMIT,
  });
  if (!error) return true;
  if (errorCode(error) === "23503") return false;
  throw storeError("Setting the limit failed", error);
}

export type RewardCounts = { eligible: number; paid: number };

/** Eligible and paid rewards per referrer, for /admin/referrals. */
export async function loadRewardCounts(admin: Pick<SupabaseClient, "from">): Promise<Map<string, RewardCounts>> {
  const rows = await readAll<{ referrer_user_id: string | null; status: string }>(
    (from, to) =>
      admin
        .from("referral_rewards")
        .select("referrer_user_id, status")
        .in("status", ["eligible", "paid"])
        .order("id")
        .range(from, to),
    "Counting rewards failed",
  );
  const counts = new Map<string, RewardCounts>();
  for (const row of rows) {
    if (!row.referrer_user_id) continue;
    const entry = counts.get(row.referrer_user_id) ?? { eligible: 0, paid: 0 };
    if (row.status === "eligible") entry.eligible += 1;
    else entry.paid += 1;
    counts.set(row.referrer_user_id, entry);
  }
  return counts;
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; reason: "too_large" | "not_json" };

/**
 * A request body as JSON, read up to `max` bytes whatever Content-Length says,
 * and no further. A parser's error can quote the text, so it goes no further.
 */
export async function readJsonBody(request: Request, max: number): Promise<JsonBody> {
  if (Number(request.headers.get("content-length")) > max) return { ok: false, reason: "too_large" };
  if (!request.body) return { ok: false, reason: "not_json" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(all)) };
  } catch {
    return { ok: false, reason: "not_json" };
  }
}
