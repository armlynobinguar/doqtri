import type { SupabaseClient } from "@supabase/supabase-js";
import { isReferralSource, REFERRAL_SOURCES, type ReferralSource } from "@/lib/referral";

/**
 * Referral tracking for /admin/referrals: totals, who refers the most, and
 * the latest sign-ups, from public.referrals (service role only).
 */

export type ReferralRow = {
  referred_user_id: string;
  referrer_user_id: string;
  code: string;
  source: ReferralSource;
  created_at: string;
};

export type SourceCounts = Record<ReferralSource, number>;

export type ReferrerStat = {
  userId: string;
  code: string;
  total: number;
  via: SourceCounts;
  /** When their latest referral signed up. */
  lastAt: string;
};

export type ReferralSummary = {
  total: number;
  via: SourceCounts;
  last7Days: number;
  last30Days: number;
  /** Referrers, most referrals first; ties go to the most recent. */
  referrers: ReferrerStat[];
};

const DAY_MS = 24 * 60 * 60_000;

function emptyCounts(): SourceCounts {
  return Object.fromEntries(REFERRAL_SOURCES.map((s) => [s, 0])) as SourceCounts;
}

export function summarizeReferrals(rows: ReferralRow[], now: number = Date.now()): ReferralSummary {
  const via = emptyCounts();
  const byReferrer = new Map<string, ReferrerStat>();
  let last7Days = 0;
  let last30Days = 0;

  for (const row of rows) {
    via[row.source] += 1;
    const age = now - Date.parse(row.created_at);
    if (age <= 7 * DAY_MS) last7Days += 1;
    if (age <= 30 * DAY_MS) last30Days += 1;

    let stat = byReferrer.get(row.referrer_user_id);
    if (!stat) {
      stat = { userId: row.referrer_user_id, code: row.code, total: 0, via: emptyCounts(), lastAt: row.created_at };
      byReferrer.set(row.referrer_user_id, stat);
    }
    stat.total += 1;
    stat.via[row.source] += 1;
    if (row.created_at > stat.lastAt) stat.lastAt = row.created_at;
  }

  const referrers = [...byReferrer.values()].sort(
    (a, b) => b.total - a.total || b.lastAt.localeCompare(a.lastAt),
  );
  return { total: rows.length, via, last7Days, last30Days, referrers };
}

/** PostgREST returns at most 1,000 rows a request: page through them all. */
const PAGE = 1000;

/** Every referral, newest first. */
export async function loadReferrals(admin: SupabaseClient): Promise<ReferralRow[]> {
  const rows: ReferralRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("referrals")
      .select("referred_user_id, referrer_user_id, code, source, created_at")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to load referrals: ${error.message}`);
    for (const row of data ?? []) {
      rows.push({ ...row, source: isReferralSource(row.source) ? row.source : "link" } as ReferralRow);
    }
    if (!data || data.length < PAGE) return rows;
  }
}
