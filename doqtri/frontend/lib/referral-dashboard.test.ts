import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canEditPayout,
  joinedDay,
  loadReferralDashboard,
  maskedReferralIdentity,
  maskEmail,
  maskWallet,
  referralDashboardLive,
  referralLimit,
  referralListRow,
  referralPage,
  referralStatus,
  referralTotals,
  UNKNOWN_REFERRAL,
  type ReferralDashboardRecord,
} from "@/lib/referral-dashboard";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import { WALLET_EMAIL_DOMAIN } from "@/lib/wallet-address";

/** The referral dashboard's masking and arithmetic (WP-4.6, DOQ-24, D-111). */

const G = "GABC" + "A".repeat(48) + "WXYZ";
const C = "CDEF" + "B".repeat(48) + "PQRS";

const record = (over: Partial<ReferralDashboardRecord> = {}): ReferralDashboardRecord => ({
  email: "tycoon@gmail.com",
  g_wallet: null,
  c_wallet: null,
  referred_on: "2026-11-01",
  source: "link",
  activity_count: 0,
  reward_status: null,
  amount_php: null,
  former_user: false,
  ...over,
});

describe("the rules the page states", () => {
  it("are 3 activities, 30 PHP and a limit of 30", () => {
    expect([REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_PHP, REFERRAL_REWARD_LIMIT]).toEqual([3, 30, 30]);
  });
});

describe("the switch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off while LEGAL_OPERATOR_NAME is unset, empty or blank", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", undefined as unknown as string);
    expect(referralDashboardLive()).toBe(false);
    vi.stubEnv("LEGAL_OPERATOR_NAME", "");
    expect(referralDashboardLive()).toBe(false);
    vi.stubEnv("LEGAL_OPERATOR_NAME", "   ");
    expect(referralDashboardLive()).toBe(false);
  });

  it("is on once it names someone", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
    expect(referralDashboardLive()).toBe(true);
  });

  it("isn't fooled by a public variable", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "");
    vi.stubEnv("NEXT_PUBLIC_LEGAL_OPERATOR_NAME", "Test Operator");
    expect(referralDashboardLive()).toBe(false);
  });
});

describe("masking an email", () => {
  it.each([
    ["tycoon@gmail.com", "ty•••@gmail.com"],
    ["  tycoon@gmail.com ", "ty•••@gmail.com"],
    ["abcd@yahoo.com", "ab•••@yahoo.com"],
    ["abc@outlook.com", "a•••@outlook.com"],
    ["ab@hotmail.com", "a•••@hotmail.com"],
    ["a@live.com", "•••@live.com"],
    ["tycoon@icloud.com", "ty•••@icloud.com"],
    ["tycoon@proton.me", "ty•••@proton.me"],
    ["tycoon@yahoo.com.ph", "ty•••@yahoo.com.ph"],
    ["名前です@gmail.com", "名前•••@gmail.com"],
  ])("a large provider keeps its domain: %s becomes %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it("reads a provider's domain in any case, and shows it in lower case", () => {
    expect(maskEmail("TyCoon@GMAIL.COM")).toBe("Ty•••@gmail.com");
  });

  it.each([
    ["john.smith@john-smith.com", "jo•••@•••.com"],
    ["abcd@x.com", "ab•••@•••.com"],
    ["ab@x.com", "a•••@•••.com"],
    ["a@x.com", "•••@•••.com"],
    ["ab@X.COM", "a•••@•••.com"],
    ["名前です@example.jp", "名前•••@•••.jp"],
    ["ab@acme.com.ph", "a•••@•••.ph"],
  ])("anyone else's domain goes, in case it's their own: %s becomes %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it.each([
    ["me@mail.gmail.com", "m•••@•••.com"],
    ["ab@gmail.com.evil.org", "a•••@•••.org"],
    ["ab@notgmail.com", "a•••@•••.com"],
    ["ab@gmail.co", "a•••@•••.co"],
  ])("a subdomain or lookalike of a provider isn't that provider: %s becomes %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it.each([
    ["john@john.smith", "jo•••@•••"],
    ["abcd@family.museum", "ab•••@•••"],
    ["ab@x.com.", "a•••@•••"],
    ["ab@acme.xn--p1ai", "a•••@•••"],
  ])("a rarer ending goes too: %s becomes %s", (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it("never shows any part of a domain of someone's own", () => {
    const shown = maskEmail("john.smith@smith.family.example.com");
    expect(shown).not.toContain("smith");
    expect(shown).not.toContain("family");
    expect(shown).not.toContain("example");
  });

  it.each([[null], [undefined], [""], ["   "], ["not-an-email"], ["@x.com"], ["a@"], ["a@b@c.com"], ["a b@c.com"], ["a@nodot"]])(
    "%s isn't plainly an email, so it gives nothing",
    (email) => {
      expect(maskEmail(email)).toBeNull();
    },
  );
});

describe("the day someone joined", () => {
  it("is a day and no more", () => {
    expect(joinedDay(record({ referred_on: "2026-11-01" }))).toBe("2026-11-01");
  });

  it("drops a time, in UTC, should the database ever send one", () => {
    expect(joinedDay(record({ referred_on: "2026-11-01T23:59:58+00:00" }))).toBe("2026-11-01");
    expect(joinedDay(record({ referred_on: "2026-11-02T01:00:00+08:00" }))).toBe("2026-11-01");
  });

  it("is nothing for a former user, whatever the row holds", () => {
    expect(joinedDay(record({ former_user: true, referred_on: "2026-11-01" }))).toBeNull();
    expect(joinedDay(record({ former_user: true, referred_on: null }))).toBeNull();
  });

  it("is nothing when there's nothing readable", () => {
    expect(joinedDay(record({ referred_on: null }))).toBeNull();
    expect(joinedDay(record({ referred_on: "soon" }))).toBeNull();
  });
});

describe("masking a wallet", () => {
  it("keeps four characters at each end", () => {
    expect(maskWallet(G)).toBe("GABC…WXYZ");
    expect(maskWallet(C)).toBe("CDEF…PQRS");
  });

  it.each([[null], [undefined], [""], ["GABC"], [G.toLowerCase()], [G + "A"], ["X" + G.slice(1)]])(
    "%s isn't an address, so it gives nothing",
    (address) => {
      expect(maskWallet(address)).toBeNull();
    },
  );
});

describe("who a referred user shows as", () => {
  const synthetic = `${G.toLowerCase()}@${WALLET_EMAIL_DOMAIN}`;

  it("an email account: the masked email, even with a passkey wallet", () => {
    expect(maskedReferralIdentity(record({ c_wallet: C }))).toBe("ty•••@gmail.com");
  });

  it("a wallet login: the wallet in its synthetic email, never the email", () => {
    const shown = maskedReferralIdentity(record({ email: synthetic, g_wallet: G }));
    expect(shown).toBe("GABC…WXYZ");
    expect(shown).not.toContain(WALLET_EMAIL_DOMAIN);
  });

  it("the synthetic domain in capitals is still synthetic", () => {
    expect(maskedReferralIdentity(record({ email: synthetic.toUpperCase() }))).toBe("GABC…WXYZ");
  });

  it("a synthetic email that holds no address: the wallet record, not the email", () => {
    const shown = maskedReferralIdentity(record({ email: `whoever@${WALLET_EMAIL_DOMAIN}`, c_wallet: C }));
    expect(shown).toBe("CDEF…PQRS");
  });

  it("a synthetic email and no wallet at all: neither the email nor a piece of it", () => {
    expect(maskedReferralIdentity(record({ email: `whoever@${WALLET_EMAIL_DOMAIN}` }))).toBe(UNKNOWN_REFERRAL);
  });

  it("a malformed or missing email: the wallet", () => {
    expect(maskedReferralIdentity(record({ email: "garbage", g_wallet: G }))).toBe("GABC…WXYZ");
    expect(maskedReferralIdentity(record({ email: null, c_wallet: C }))).toBe("CDEF…PQRS");
  });

  it("nothing usable: a neutral label, and the malformed email stays hidden", () => {
    expect(maskedReferralIdentity(record({ email: "garbage" }))).toBe(UNKNOWN_REFERRAL);
    expect(maskedReferralIdentity(record({ email: null }))).toBe(UNKNOWN_REFERRAL);
  });

  it("an unusable wallet is never shown raw", () => {
    expect(maskedReferralIdentity(record({ email: null, g_wallet: "nonsense" }))).toBe(UNKNOWN_REFERRAL);
  });

  it("a deleted account: Former user, whatever else the row holds", () => {
    expect(maskedReferralIdentity(record({ email: null, former_user: true }))).toBe("Former user");
    expect(maskedReferralIdentity(record({ g_wallet: G, former_user: true }))).toBe("Former user");
  });
});

describe("statuses", () => {
  it.each([
    [null, "pending"],
    ["eligible", "eligible"],
    ["over_limit", "over_limit"],
    ["paid", "paid"],
    ["void", "not_eligible"],
  ])("%s is %s", (stored, status) => {
    expect(referralStatus(stored)).toBe(status);
  });
});

describe("a list row", () => {
  it("is built field by field, so nothing else on a record comes along", () => {
    const row = referralListRow({
      ...record({ activity_count: 2 }),
      referred_user_id: "secret",
      void_reason: "secret",
    } as ReferralDashboardRecord);
    expect(row).toEqual({
      identity: "ty•••@gmail.com",
      former: false,
      joinedOn: "2026-11-01",
      activity: 2,
      status: "pending",
      amountPhp: null,
    });
  });

  it("shows an amount only for what adds to the totals", () => {
    expect(referralListRow(record({ reward_status: "eligible", amount_php: 30 })).amountPhp).toBe(30);
    expect(referralListRow(record({ reward_status: "paid", amount_php: 45 })).amountPhp).toBe(45);
    expect(referralListRow(record({ reward_status: "over_limit", amount_php: 30 })).amountPhp).toBeNull();
    expect(referralListRow(record({ reward_status: "void", amount_php: 30 })).amountPhp).toBeNull();
  });

  it("a former user has no activity to show, and keeps their reward", () => {
    const row = referralListRow(
      record({ email: null, former_user: true, activity_count: null, reward_status: "eligible", amount_php: 30 }),
    );
    expect(row).toMatchObject({ identity: "Former user", former: true, joinedOn: null, activity: null, amountPhp: 30 });
  });
});

describe("totals", () => {
  const records = [
    record({ reward_status: "eligible", amount_php: 30 }),
    // A reward keeps what it was worth when it qualified: not the current constant.
    record({ reward_status: "eligible", amount_php: 20 }),
    record({ reward_status: "paid", amount_php: 45 }),
    record({ reward_status: "over_limit", amount_php: 30 }),
    record({ reward_status: "void", amount_php: 30 }),
    record({ reward_status: null }),
    record({ email: null, former_user: true, reward_status: "eligible", amount_php: 30 }),
  ];

  it("sum stored amounts: earned is eligible and paid, unpaid eligible, paid paid", () => {
    expect(referralTotals(records)).toEqual({ referred: 7, eligible: 3, earnedPhp: 125, unpaidPhp: 80, paidPhp: 45 });
  });

  it("over limit and void add nothing, though they count as referred", () => {
    const totals = referralTotals([
      record({ reward_status: "over_limit", amount_php: 30 }),
      record({ reward_status: "void", amount_php: 30 }),
    ]);
    expect(totals).toEqual({ referred: 2, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 });
  });

  it("are zero for nobody", () => {
    expect(referralTotals([])).toEqual({ referred: 0, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 });
  });
});

describe("the limit", () => {
  it("isn't reached one below, and is at it and above", () => {
    expect(referralLimit(null, 29)).toEqual({ limit: 30, used: 29, reached: false });
    expect(referralLimit(null, 30)).toEqual({ limit: 30, used: 30, reached: true });
    expect(referralLimit(null, 31).reached).toBe(true);
  });

  it("uses the referrer's own limit where an admin set one", () => {
    expect(referralLimit(50, 30)).toEqual({ limit: 50, used: 30, reached: false });
    expect(referralLimit(50, 50).reached).toBe(true);
    expect(referralLimit(10, 10).reached).toBe(true);
    // Zero is a limit, not a missing one.
    expect(referralLimit(0, 0)).toEqual({ limit: 0, used: 0, reached: true });
  });
});

describe("the page asked for", () => {
  it.each([
    [null, 1],
    ["", 1],
    ["1", 1],
    ["7", 7],
    ["0", 1],
    ["-2", 1],
    ["1.5", 1],
    ["abc", 1],
    ["1e99", 1],
  ])("%s is page %s", (value, page) => {
    expect(referralPage(value)).toBe(page);
  });
});

describe("loading", () => {
  type Saved = Record<string, unknown> | null;
  function client(
    all: ReferralDashboardRecord[],
    { used = 0, override = null as number | null, saved = null as Saved, payoutError = false } = {},
  ) {
    const ranges: [number, number][] = [];
    /** Every query, with its own columns and filters, so one can't be mistaken for another. */
    const queries: { table: string; columns: string; filters: [string, unknown][] }[] = [];
    const admin = {
      rpc: () => ({
        range: async (from: number, to: number) => {
          ranges.push([from, to]);
          return { data: all.slice(from, to + 1), error: null };
        },
      }),
      from: (table: string) => {
        const entry = { table, columns: "", filters: [] as [string, unknown][] };
        queries.push(entry);
        const query = {
          select: (columns: string) => {
            entry.columns = columns;
            return query;
          },
          eq: (column: string, value: unknown) => {
            entry.filters.push([column, value]);
            return query;
          },
          maybeSingle: async () => {
            if (table !== "referral_payout_profiles") {
              return { data: override === null ? null : { reward_limit: override }, error: null };
            }
            return payoutError
              ? { data: null, error: { code: "XX000", message: "row (Account Holder, 09171234567)" } }
              : { data: saved, error: null };
          },
          in: async (column: string, value: unknown) => {
            entry.filters.push([column, value]);
            return { count: used, error: null };
          },
        };
        return query;
      },
    };
    return { admin: admin as unknown as Parameters<typeof loadReferralDashboard>[0], ranges, queries };
  }

  const many = (n: number) =>
    Array.from({ length: n }, () => record({ reward_status: "eligible", amount_php: REFERRAL_REWARD_PHP }));

  it("totals everything, across PostgREST's 1,000-row pages, and masks one page", async () => {
    const { admin, ranges } = client(many(2003));
    const dashboard = await loadReferralDashboard(admin, "me", "testnet", 2);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(dashboard.totals).toEqual({
      referred: 2003,
      eligible: 2003,
      earnedPhp: 60090,
      unpaidPhp: 60090,
      paidPhp: 0,
    });
    expect(dashboard.rows).toHaveLength(20);
    expect(dashboard).toMatchObject({ page: 2, pages: 101, pageSize: 20, payoutNeeded: true });
  });

  it("a page past the end shows the last one", async () => {
    const dashboard = await loadReferralDashboard(client(many(45)).admin, "me", "testnet", 99);
    expect(dashboard).toMatchObject({ page: 3, pages: 3 });
    expect(dashboard.rows).toHaveLength(5);
  });

  it("nobody referred is one empty page, with no payout prompt", async () => {
    const dashboard = await loadReferralDashboard(client([]).admin, "me", "testnet", 1);
    expect(dashboard).toMatchObject({ rows: [], page: 1, pages: 1, payoutNeeded: false });
  });

  it("no payout prompt for rewards already paid", async () => {
    const paid = [record({ reward_status: "paid", amount_php: 30 })];
    expect((await loadReferralDashboard(client(paid).admin, "me", "testnet", 1)).payoutNeeded).toBe(false);
  });

  it("the limit counts the referrer's eligible and paid rewards on every network, as the database does", async () => {
    // One testnet row here, thirty rewards counted: the mainnet ones count too.
    const { admin, queries } = client([record({ reward_status: "eligible", amount_php: 30 })], { used: 30 });
    const dashboard = await loadReferralDashboard(admin, "me", "testnet", 1);
    expect(dashboard.limit).toEqual({ limit: 30, used: 30, reached: true });
    const counts = queries.filter((q) => q.table === "referral_rewards");
    expect(counts.map((q) => q.filters)).toContainEqual([
      ["referrer_user_id", "me"],
      ["status", ["eligible", "paid"]],
    ]);
  });

  it("opens the questionnaire on an eligible or paid reward, from the rows it already read", async () => {
    const opens = async (rows: ReferralDashboardRecord[]) => {
      const { admin, queries } = client(rows);
      const dashboard = await loadReferralDashboard(admin, "me", "testnet", 1);
      // No count of its own: the limit's is the only one.
      expect(queries.filter((q) => q.table === "referral_rewards")).toHaveLength(1);
      return dashboard.payout.canEdit;
    };
    expect(await opens([record({ reward_status: "eligible", amount_php: 30 })])).toBe(true);
    expect(await opens([record({ reward_status: "paid", amount_php: 30 })])).toBe(true);
    // A deleted referred user's reward still counts, as the route's own check counts it.
    expect(await opens([record({ former_user: true, reward_status: "eligible", amount_php: 30 })])).toBe(true);
    expect(await opens([record({ reward_status: "over_limit" }), record({ reward_status: "void" }), record()])).toBe(
      false,
    );
    expect(await opens([])).toBe(false);
  });

  it("is the same rule as the route's", () => {
    for (const status of ["eligible", "paid", "over_limit", "void", null]) {
      expect(canEditPayout([{ reward_status: status }])).toBe(status === "eligible" || status === "paid");
    }
  });

  const SAVED = {
    method: "ewallet",
    xlm_address: null,
    xlm_memo_type: null,
    ewallet_provider: "GCash",
    ewallet_account_number: "09171234567",
  };

  it("an unpaid reward needs details until they're saved, then shows them masked, from the summary's columns only", async () => {
    const unpaid = [record({ reward_status: "eligible", amount_php: 30 })];
    expect((await loadReferralDashboard(client(unpaid).admin, "me", "testnet", 1)).payoutNeeded).toBe(true);
    const { admin, queries } = client(unpaid, { saved: SAVED });
    const dashboard = await loadReferralDashboard(admin, "me", "testnet", 1);
    expect(dashboard.payoutNeeded).toBe(false);
    expect(dashboard.payout).toEqual({ canEdit: true, summary: { label: "GCash", last4: "4567" } });
    expect(JSON.stringify(dashboard)).not.toContain("09171234567");
    const read = queries.find((q) => q.table === "referral_payout_profiles");
    expect(read).toEqual({
      table: "referral_payout_profiles",
      columns: "method, xlm_address, xlm_memo_type, ewallet_provider, ewallet_account_number",
      filters: [["user_id", "me"]],
    });
    for (const column of ["name", "xlm_memo,", "ewallet_account_name", "ewallet_details"]) {
      expect(`${read!.columns},`).not.toContain(column);
    }
  });

  it("an XLM summary carries the memo's type and never the memo", async () => {
    const saved = { method: "xlm", xlm_address: G, xlm_memo_type: "id", ewallet_provider: null, ewallet_account_number: null };
    const dashboard = await loadReferralDashboard(client([], { saved }).admin, "me", "testnet", 1);
    expect(dashboard.payout.summary).toEqual({ label: "XLM", last4: "WXYZ", memoType: "id" });
  });

  it("still loads when the payout details can't be read, saying so, and logs the label alone", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const unpaid = [record({ reward_status: "eligible", amount_php: 30 })];
      const dashboard = await loadReferralDashboard(client(unpaid, { payoutError: true }).admin, "me", "testnet", 1);
      expect(dashboard.totals.unpaidPhp).toBe(30);
      expect(dashboard.rows).toHaveLength(1);
      expect(dashboard.payout).toEqual({ canEdit: true, summary: null, unavailable: true });
      // Not "needed": whether details are saved is unknown, so it doesn't nag.
      expect(dashboard.payoutNeeded).toBe(false);
      expect(log.mock.calls).toEqual([["[referrals] payout details not loaded for the dashboard"]]);
    } finally {
      log.mockRestore();
    }
  });

  it("uses the override that's stored", async () => {
    const dashboard = await loadReferralDashboard(client([], { used: 30, override: 50 }).admin, "me", "testnet", 1);
    expect(dashboard.limit).toEqual({ limit: 50, used: 30, reached: false });
  });

  it("fails rather than show partial totals", async () => {
    const admin = {
      ...client([]).admin,
      rpc: () => ({ range: async () => ({ data: null, error: { message: "nope" } }) }),
    } as unknown as Parameters<typeof loadReferralDashboard>[0];
    await expect(loadReferralDashboard(admin, "me", "testnet", 1)).rejects.toThrow("Reading referrals failed");
  });
});
