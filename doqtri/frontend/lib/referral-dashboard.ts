/**
 * The referral dashboard's data (server-only, WP-4.6, DOQ-24, D-111): a
 * referrer's referrals with masked identities, their statuses, and totals from
 * the stored rewards. Read through referral_dashboard()
 * (backend/migrations/20261107110000_referral_dashboard.sql).
 *
 * Browser code imports only the types from here: what the switch reads is
 * never public.
 *
 * One network's rows and totals, against a limit counted across networks, as
 * the database counts it. That can only look odd once a referrer has rewards on
 * both, so revisit it at the network cutover.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { FORMER_USER } from "@/lib/former-user";
import { REFERRAL_REWARD_LIMIT } from "@/lib/referral-program";
import { isReservedEmail, walletAddressFromEmail } from "@/lib/wallet-address";

/**
 * Whether the dashboard exists yet. The same switch as the legal pages
 * (`lib/legal.ts`, DOQ-27 and DOQ-29, on another branch): it shows referred
 * users' masked emails and wallets and promises rewards, and neither may be
 * public before the Privacy Policy and Terms. Never a NEXT_PUBLIC_ variable:
 * client components get the answer as a prop.
 */
export function referralDashboardLive(): boolean {
  return Boolean(process.env.LEGAL_OPERATOR_NAME?.trim());
}

/** Rows on one page of the list. */
export const REFERRAL_DASHBOARD_PAGE_SIZE = 20;

/** PostgREST returns at most 1,000 rows a request. */
const READ_SIZE = 1000;

/** For a live account with neither a real email nor a wallet: nothing to mask. */
export const UNKNOWN_REFERRAL = "Private account";

/** What referral_dashboard() returns: unmasked, so it never leaves the server. */
export type ReferralDashboardRecord = {
  email: string | null;
  g_wallet: string | null;
  c_wallet: string | null;
  referred_on: string | null;
  source: string | null;
  activity_count: number | null;
  reward_status: string | null;
  amount_php: number | null;
  former_user: boolean;
};

export type ReferralStatus = "pending" | "eligible" | "over_limit" | "paid" | "not_eligible";

/** One referral as the browser gets it. */
export type ReferralListRow = {
  identity: string;
  former: boolean;
  /** A day in UTC, `2026-11-07`, never a time. Null for a former user: see joinedDay(). */
  joinedOn: string | null;
  /** Null for a former user, whose activity went with the account. */
  activity: number | null;
  status: ReferralStatus;
  /** What the reward adds to the totals; null when it adds nothing. */
  amountPhp: number | null;
};

export type ReferralTotals = {
  referred: number;
  eligible: number;
  earnedPhp: number;
  unpaidPhp: number;
  paidPhp: number;
};

export type ReferralLimit = { limit: number; used: number; reached: boolean };

export type ReferralDashboard = {
  rows: ReferralListRow[];
  page: number;
  pages: number;
  pageSize: number;
  totals: ReferralTotals;
  limit: ReferralLimit;
  /**
   * An unpaid reward. DOQ-25 narrows this to "and no payout details", and
   * adds the questionnaire's link in PayoutPrompt (components/vault/referrals-view.tsx).
   */
  payoutNeeded: boolean;
};

/**
 * Mailbox providers too large for their domain to say who someone is. Exact
 * matches only: a subdomain, or a name that merely contains one of these, could
 * be anybody's.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "gmx.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "outlook.ph",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
  "yahoo.com.ph",
  "yandex.com",
  "ymail.com",
  "zoho.com",
]);

/** Endings shared by so many domains that they say nothing. Any other could be someone's own. */
const COMMON_TLDS = new Set([
  "ai", "app", "au", "ca", "co", "com", "de", "dev", "edu", "es", "fr", "gov", "id", "in", "io", "it", "jp", "kr",
  "me", "my", "net", "nl", "org", "ph", "sg", "uk", "us",
]);

/**
 * `ty•••@gmail.com`, or `jo•••@•••.com` for a domain of someone's own, which
 * would name them: `john.smith@john-smith.com`. A rarer ending goes too:
 * `jo•••@•••`. At most half the local part shows, so a one-letter one shows
 * nothing and `a@x.com` isn't given away. Null for anything that isn't plainly an
 * email: the caller falls back to the wallet rather than guess which part is
 * safe to show.
 */
export function maskEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim();
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  const [local, rawDomain] = trimmed.split("@");
  const domain = rawDomain.toLowerCase();
  const letters = Array.from(local);
  const start = letters.slice(0, Math.min(2, Math.floor(letters.length / 2))).join("");
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) return `${start}•••@${domain}`;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return COMMON_TLDS.has(tld) ? `${start}•••@•••.${tld}` : `${start}•••@•••`;
}

/** `GABC…WXYZ`. Null for anything that isn't a Stellar address. */
export function maskWallet(address: string | null | undefined): string | null {
  if (!address || !/^[GC][A-Z2-7]{55}$/.test(address)) return null;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * The only name a referrer gets for someone they referred (D-111). A wallet
 * login's email is synthetic, `<address>@stellar.doqtri.local`, the one such
 * form there is (lib/wallet-auth.ts): it is never shown, and the wallet stands
 * in. Passkey wallets belong to email accounts, whose email is real. An email
 * that can't be masked falls back to the wallet too, and never appears itself.
 */
export function maskedReferralIdentity(
  record: Pick<ReferralDashboardRecord, "email" | "g_wallet" | "c_wallet" | "former_user">,
): string {
  if (record.former_user) return FORMER_USER;
  const email = record.email?.trim() ?? null;
  const shown = email && isReservedEmail(email) ? maskWallet(walletAddressFromEmail(email)) : maskEmail(email);
  return shown ?? maskWallet(record.g_wallet) ?? maskWallet(record.c_wallet) ?? UNKNOWN_REFERRAL;
}

/** A reward's status for the referrer: no reward yet is Pending, a void one Not eligible. */
export function referralStatus(rewardStatus: string | null): ReferralStatus {
  switch (rewardStatus) {
    case "eligible":
    case "over_limit":
    case "paid":
      return rewardStatus;
    case "void":
      return "not_eligible";
    default:
      return "pending";
  }
}

/** Only eligible and paid rewards are worth anything to the referrer. */
function countedAmount(status: ReferralStatus, amount: number | null): number | null {
  return status === "eligible" || status === "paid" ? (amount ?? 0) : null;
}

/** Totals from each reward's stored amount, which the reward was worth when it qualified. */
export function referralTotals(records: readonly ReferralDashboardRecord[]): ReferralTotals {
  const totals: ReferralTotals = { referred: records.length, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 };
  for (const record of records) {
    const status = referralStatus(record.reward_status);
    const amount = countedAmount(status, record.amount_php) ?? 0;
    totals.earnedPhp += amount;
    if (status === "eligible") {
      totals.eligible += 1;
      totals.unpaidPhp += amount;
    } else if (status === "paid") {
      totals.paidPhp += amount;
    }
  }
  return totals;
}

/**
 * The day a referred user joined, in UTC, and never more: a time can be matched
 * to public contract calls, which would give away their wallet (D-111). The
 * function already returns a day; this holds even if that changes. A former user
 * has no date, for the same reason: see the migration.
 */
export function joinedDay(record: Pick<ReferralDashboardRecord, "referred_on" | "former_user">): string | null {
  if (record.former_user || !record.referred_on) return null;
  const time = Date.parse(record.referred_on);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

/** Field by field, so anything else a record carries stays on the server. */
export function referralListRow(record: ReferralDashboardRecord): ReferralListRow {
  const status = referralStatus(record.reward_status);
  return {
    identity: maskedReferralIdentity(record),
    former: record.former_user,
    joinedOn: joinedDay(record),
    activity: record.former_user ? null : (record.activity_count ?? 0),
    status,
    amountPhp: countedAmount(status, record.amount_php),
  };
}

/** The referrer's own limit where an admin set one, else the default; reached at or above it. */
export function referralLimit(override: number | null | undefined, used: number): ReferralLimit {
  const limit = override ?? REFERRAL_REWARD_LIMIT;
  return { limit, used, reached: used >= limit };
}

/** A page number from the query string: a positive whole number, else the first. */
export function referralPage(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

async function readRecords(
  admin: Pick<SupabaseClient, "rpc">,
  referrer: string,
  network: string,
): Promise<ReferralDashboardRecord[]> {
  const records: ReferralDashboardRecord[] = [];
  for (let from = 0; ; from += READ_SIZE) {
    const { data, error } = await admin
      .rpc("referral_dashboard", { p_referrer: referrer, p_network: network })
      .range(from, from + READ_SIZE - 1);
    if (error) throw new Error(`Reading referrals failed: ${error.message}`);
    records.push(...((data ?? []) as ReferralDashboardRecord[]));
    if (!data || data.length < READ_SIZE) return records;
  }
}

/**
 * The limit is per referrer across networks, as referral_places_left() counts
 * it, while the rest of the dashboard is one network's: otherwise the notice
 * could disagree with what the database decides.
 */
async function readLimit(admin: Pick<SupabaseClient, "from">, referrer: string): Promise<ReferralLimit> {
  const [override, used] = await Promise.all([
    admin.from("referral_reward_limits").select("reward_limit").eq("user_id", referrer).maybeSingle(),
    admin
      .from("referral_rewards")
      .select("id", { count: "exact", head: true })
      .eq("referrer_user_id", referrer)
      .in("status", ["eligible", "paid"]),
  ]);
  if (override.error) throw new Error(`Reading the referral limit failed: ${override.error.message}`);
  if (used.error) throw new Error(`Counting rewards failed: ${used.error.message}`);
  return referralLimit(override.data?.reward_limit as number | undefined, used.count ?? 0);
}

/**
 * One page of the referrer's list, masked, with totals over all of it. `referrer`
 * must come from the verified session. A page past the end shows the last one.
 */
export async function loadReferralDashboard(
  admin: Pick<SupabaseClient, "rpc" | "from">,
  referrer: string,
  network: string,
  requestedPage: number,
): Promise<ReferralDashboard> {
  const [records, limit] = await Promise.all([readRecords(admin, referrer, network), readLimit(admin, referrer)]);
  const pageSize = REFERRAL_DASHBOARD_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(records.length / pageSize));
  const page = Math.min(requestedPage, pages);
  const totals = referralTotals(records);
  return {
    rows: records.slice((page - 1) * pageSize, page * pageSize).map(referralListRow),
    page,
    pages,
    pageSize,
    totals,
    limit,
    payoutNeeded: totals.unpaidPhp > 0,
  };
}
