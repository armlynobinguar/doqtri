/**
 * Reading and writing a referrer's payout details (server-only, WP-4.6, DOQ-25,
 * D-112), in public.referral_payout_profiles. Browser code imports only the types
 * in lib/referral-payout.ts.
 *
 * These are financial details: they are never logged, and what a failure carries
 * is PayoutStoreError's fixed text and the database's error code, not its message,
 * which could quote a row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  payoutSummary,
  type PayoutMemoType,
  type PayoutProfile,
  type PayoutProvider,
  type PayoutSummary,
} from "@/lib/referral-payout";

const TABLE = "referral_payout_profiles";

const COLUMNS =
  "method, name, xlm_address, xlm_memo, xlm_memo_type, ewallet_provider, ewallet_account_name, ewallet_account_number, ewallet_details";

/** What the masked summary is made from, and nothing more: no name, memo, account name or details. */
const SUMMARY_COLUMNS = "method, xlm_address, xlm_memo_type, ewallet_provider, ewallet_account_number";

type PayoutProfileRow = {
  method: "xlm" | "ewallet";
  name: string;
  xlm_address: string | null;
  xlm_memo: string | null;
  xlm_memo_type: PayoutMemoType | null;
  ewallet_provider: PayoutProvider | null;
  ewallet_account_name: string | null;
  ewallet_account_number: string | null;
  ewallet_details: string | null;
};

export class PayoutStoreError extends Error {
  constructor(
    what: string,
    readonly code: string,
  ) {
    super(`${what} (${code})`);
    this.name = "PayoutStoreError";
  }
}

function storeError(what: string, error: { code?: string }): PayoutStoreError {
  return new PayoutStoreError(what, /^[A-Za-z0-9]{1,10}$/.test(error.code ?? "") ? error.code! : "unknown");
}

/**
 * Who can use the form: someone with at least one eligible referral, which here
 * means a referral_rewards row with status `eligible` or `paid`, for this referrer,
 * on this network. A paid one counts, so a referrer whose rewards have all been paid
 * can still keep their details current. Over limit and void don't count: neither is
 * owed anything. Service role, since only it can read referral_rewards. `referrer`
 * must come from the verified session.
 */
export async function hasEligibleReferral(
  admin: Pick<SupabaseClient, "from">,
  referrer: string,
  network: string,
): Promise<boolean> {
  const { count, error } = await admin
    .from("referral_rewards")
    .select("id", { count: "exact", head: true })
    .eq("referrer_user_id", referrer)
    .eq("network", network)
    .in("status", ["eligible", "paid"]);
  if (error) throw storeError("Checking eligibility failed", error);
  return (count ?? 0) > 0;
}

function profileFromRow(row: PayoutProfileRow): PayoutProfile {
  return row.method === "xlm"
    ? { method: "xlm", name: row.name, address: row.xlm_address!, memo: row.xlm_memo, memoType: row.xlm_memo_type }
    : {
        method: "ewallet",
        name: row.name,
        provider: row.ewallet_provider!,
        accountName: row.ewallet_account_name!,
        accountNumber: row.ewallet_account_number!,
        details: row.ewallet_details,
      };
}

/**
 * Every column, so that saving one method clears the other's, as the table's
 * check requires (AC 4). Takes the id separately: it comes from the session.
 */
export function payoutProfileRow(userId: string, profile: PayoutProfile) {
  const xlm = profile.method === "xlm" ? profile : null;
  const ewallet = profile.method === "ewallet" ? profile : null;
  return {
    user_id: userId,
    method: profile.method,
    name: profile.name,
    xlm_address: xlm?.address ?? null,
    xlm_memo: xlm?.memo ?? null,
    xlm_memo_type: xlm?.memoType ?? null,
    ewallet_provider: ewallet?.provider ?? null,
    ewallet_account_name: ewallet?.accountName ?? null,
    ewallet_account_number: ewallet?.accountNumber ?? null,
    ewallet_details: ewallet?.details ?? null,
    updated_at: new Date().toISOString(),
  };
}

/** The saved details, or null. `client` is the user's session, where RLS holds, or the service role. */
export async function readPayoutProfile(
  client: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<PayoutProfile | null> {
  const { data, error } = await client.from(TABLE).select(COLUMNS).eq("user_id", userId).maybeSingle();
  if (error) throw storeError("Reading payout details failed", error);
  return data ? profileFromRow(data as PayoutProfileRow) : null;
}

/** Replaces the user's details. An edit only ever changes this row, so a payout already made stays as it was. */
export async function savePayoutProfile(
  admin: Pick<SupabaseClient, "from">,
  userId: string,
  profile: PayoutProfile,
): Promise<void> {
  const { error } = await admin.from(TABLE).upsert(payoutProfileRow(userId, profile), { onConflict: "user_id" });
  if (error) throw storeError("Saving payout details failed", error);
}

/**
 * For the dashboard: the masked view of what's saved, or null, read from only the
 * columns it's made of. Service role: `userId` must come from the verified session.
 */
export async function readPayoutSummary(
  admin: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<PayoutSummary | null> {
  const { data, error } = await admin.from(TABLE).select(SUMMARY_COLUMNS).eq("user_id", userId).maybeSingle();
  if (error) throw storeError("Reading payout details failed", error);
  if (!data) return null;
  const row = data as Pick<
    PayoutProfileRow,
    "method" | "xlm_address" | "xlm_memo_type" | "ewallet_provider" | "ewallet_account_number"
  >;
  return row.method === "xlm"
    ? payoutSummary({ method: "xlm", address: row.xlm_address!, memoType: row.xlm_memo_type })
    : payoutSummary({ method: "ewallet", provider: row.ewallet_provider!, accountNumber: row.ewallet_account_number! });
}
