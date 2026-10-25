import { describe, expect, it } from "vitest";
import { summarizeReferrals, type ReferralRow } from "./referral-report";

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60_000).toISOString();

function row(referrer: string, referred: string, source: ReferralRow["source"], days: number): ReferralRow {
  return {
    referrer_user_id: referrer,
    referred_user_id: referred,
    code: `code${referrer}`,
    source,
    created_at: daysAgo(days),
  };
}

describe("summarizeReferrals", () => {
  it("is all zeros with no referrals", () => {
    expect(summarizeReferrals([], NOW)).toEqual({
      total: 0,
      via: { link: 0, qr: 0, code: 0 },
      last7Days: 0,
      last30Days: 0,
      referrers: [],
    });
  });

  it("counts by source and by age", () => {
    const summary = summarizeReferrals(
      [row("a", "1", "link", 1), row("a", "2", "qr", 10), row("b", "3", "code", 40), row("b", "4", "qr", 7)],
      NOW,
    );
    expect(summary.total).toBe(4);
    expect(summary.via).toEqual({ link: 1, qr: 2, code: 1 });
    expect(summary.last7Days).toBe(2);
    expect(summary.last30Days).toBe(3);
  });

  it("ranks referrers by total, then by their latest referral", () => {
    const { referrers } = summarizeReferrals(
      [row("a", "1", "link", 5), row("b", "2", "qr", 2), row("c", "3", "link", 1), row("c", "4", "code", 30)],
      NOW,
    );
    expect(referrers.map((r) => r.userId)).toEqual(["c", "b", "a"]);
    expect(referrers[0]).toEqual({
      userId: "c",
      code: "codec",
      total: 2,
      via: { link: 1, qr: 0, code: 1 },
      lastAt: daysAgo(1),
    });
  });
});
