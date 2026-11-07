import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET and POST /api/admin/referrals/payouts (WP-4.6, DOQ-26): a 404 for anyone
 * but an admin (AC 1), never cached (AC 9), the queue and the review list, the
 * two payout steps (start, record) and release, their checks and refusals in
 * fixed words (who already paid, who is paying), and payout details never in a
 * log (AC 9).
 */

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000b2";
const REFERRER = "00000000-0000-4000-8000-0000000000c3";
const REWARD = "00000000-0000-4000-8000-0000000000d4";
const ACCOUNT_NUMBER = "0917 555 0101";

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  adminUsed: 0,
  calls: [] as { name: string; args: unknown }[],
  results: {} as Record<string, { data: unknown; error: { code?: string; message?: string } | null }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
  createSupabaseAdminClient: () => {
    state.adminUsed += 1;
    return {
      rpc: (name: string, args?: unknown) => {
        state.calls.push({ name, args });
        const result = () => state.results[name] ?? { data: null, error: null };
        return {
          range: async () => result(),
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(result()).then(resolve, reject),
        };
      },
    };
  },
}));
vi.mock("@/lib/stellar/smart-wallet-config", () => ({ NETWORK: "testnet" }));

const { GET, POST } = await import("./route");

const QUEUE_RECORD = {
  referrer_user_id: REFERRER,
  email: "referrer@example.com",
  g_wallet: null,
  eligible_rewards: [
    { id: REWARD, amount_php: 30, qualified_at: "2026-11-01T00:00:00+00:00" },
    { id: "00000000-0000-4000-8000-0000000000d5", amount_php: 45, qualified_at: "2026-11-02T00:00:00+00:00" },
  ],
  over_limit_count: 1,
  paid_count: 2,
  void_count: 0,
  reward_limit: null,
  method: "ewallet",
  name: "Payout Holder",
  xlm_address: null,
  xlm_memo: null,
  xlm_memo_type: null,
  ewallet_provider: "GCash",
  ewallet_account_name: "Payout Holder",
  ewallet_account_number: ACCOUNT_NUMBER,
  ewallet_details: null,
  details_created_at: "2026-10-01T00:00:00+00:00",
  details_updated_at: "2026-10-02T00:00:00+00:00",
  claim_admin_id: ADMIN,
  claim_admin_email: "admin@example.com",
  claim_admin_wallet: null,
  claimed_at: "2026-11-07T10:00:00+00:00",
  claim_expires_at: "2026-11-07T12:00:00+00:00",
};

const REQUEST = {
  referrerId: REFERRER,
  rewardIds: [REWARD],
  amountPhp: 30,
  detailsUpdatedAt: "2026-10-02T00:00:00+00:00",
};
const START = { action: "start", ...REQUEST };
const GOOD = { action: "record", ...REQUEST, reference: "  abc123  " };
const RELEASE = { action: "release", referrerId: REFERRER };

const STARTED = {
  claimed_at: "2026-11-07T10:00:00+00:00",
  expires_at: "2026-11-07T12:00:00+00:00",
  method: "ewallet",
  name: "Payout Holder",
  xlm_address: null,
  xlm_memo: null,
  xlm_memo_type: null,
  ewallet_provider: "GCash",
  ewallet_account_name: "Payout Holder",
  ewallet_account_number: ACCOUNT_NUMBER,
  ewallet_details: null,
  details_created_at: "2026-10-01T00:00:00+00:00",
  details_updated_at: "2026-10-02T00:00:00.123456+00:00",
};

const PAID_CONFLICT = {
  claim: null,
  paid: [
    {
      admin_id: "00000000-0000-4000-8000-0000000000a9",
      email: "other-admin@example.com",
      wallet: null,
      paid_at: "2026-11-07T14:05:00+00:00",
      amount_php: 30,
      reward_count: 1,
    },
  ],
};
const BUSY_CONFLICT = {
  claim: {
    admin_id: "00000000-0000-4000-8000-0000000000a9",
    email: "other-admin@example.com",
    wallet: null,
    claimed_at: "2026-11-07T10:00:00+00:00",
    expires_at: "2026-11-07T12:00:00+00:00",
  },
  paid: [],
};

const get = (query = "") => GET(new Request(`http://localhost/api/admin/referrals/payouts${query}`));
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/admin/referrals/payouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

let consoleCalls: unknown[][] = [];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("DOQTRI_ADMINS", ADMIN);
  // The legal pages' switch is off: the admin panel doesn't wait for it.
  vi.stubEnv("LEGAL_OPERATOR_NAME", "");
  state.user = { id: ADMIN, email: "admin@example.com" };
  state.adminUsed = 0;
  state.calls = [];
  state.results = {};
  consoleCalls = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => vi.restoreAllMocks());

describe("anyone but an admin (AC 1)", () => {
  it.each([
    ["signed out", null],
    ["a signed-in user", { id: USER, email: "user@example.com" }],
  ])("gets a 404 from GET and POST, %s, touching nothing", async (_who, user) => {
    state.user = user;
    for (const res of [await get(), await get(`?referrer=${REFERRER}`), await post(START), await post(GOOD), await post(RELEASE)]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(state.adminUsed).toBe(0);
  });

  it("gets a 404 with no admins configured at all", async () => {
    vi.stubEnv("DOQTRI_ADMINS", "");
    expect((await get()).status).toBe(404);
  });
});

describe("GET", () => {
  it("returns the queue, shaped, with the details in full, never cached and never logged (AC 2, AC 9)", async () => {
    state.results.referral_payout_queue = { data: [QUEUE_RECORD], error: null };
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      referrerId: REFERRER,
      identity: "referrer@example.com",
      owedPhp: 75,
      eligibleCount: 2,
      overLimitCount: 1,
      paidCount: 2,
      details: { profile: { accountNumber: ACCOUNT_NUMBER }, savedAt: "2026-10-01T00:00:00+00:00" },
      claim: { by: "admin@example.com", since: "2026-11-07T10:00:00+00:00", mine: true },
    });
    expect(JSON.stringify(consoleCalls)).not.toContain(ACCOUNT_NUMBER);
  });

  it("returns a referrer's referrals for review, on the app's network", async () => {
    state.results.referral_payout_referrals = {
      data: [
        {
          reward_id: REWARD,
          email: "referred@example.com",
          g_wallet: null,
          c_wallet: null,
          referred_wallet: `G${"A".repeat(55)}`,
          signed_up_at: "2026-11-01T00:00:00+00:00",
          referred_at: "2026-11-01T00:00:01+00:00",
          source: "link",
          network: "testnet",
          activity_count: 3,
          qualified_at: "2026-11-02T00:00:00+00:00",
          reward_status: "eligible",
          void_reason: null,
          amount_php: 30,
          former_user: false,
        },
      ],
      error: null,
    };
    const res = await get(`?referrer=${REFERRER}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).referrals[0]).toMatchObject({ identity: "referred@example.com", activity: 3, canVoid: true });
    expect(state.calls).toEqual([
      { name: "referral_payout_referrals", args: { p_referrer: REFERRER, p_network: "testnet" } },
    ]);
  });

  it.each(["nope", "../x", `${REFERRER}0`, ""])("answers 404 to a referrer id that isn't one: %j", async (id) => {
    const res = await get(`?referrer=${encodeURIComponent(id)}`);
    expect(res.status).toBe(404);
    expect(state.calls).toEqual([]);
  });

  it("fails with fixed text and logs only the code, whatever the database said", async () => {
    state.results.referral_payout_queue = {
      data: null,
      error: { code: "XX000", message: `row ${ACCOUNT_NUMBER} broke` },
    };
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "The payout queue couldn't be loaded." });
    expect(JSON.stringify(consoleCalls)).not.toContain(ACCOUNT_NUMBER);
    expect(consoleCalls).toEqual([["[admin/referrals] payouts not loaded", "XX000"]]);
  });
});

describe("POST start: step one", () => {
  it("holds the payout for the admin from the session, and answers the details as they are now", async () => {
    state.results.start_referral_payout = { data: STARTED, error: null };
    const res = await post({ ...START, adminId: USER });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.started).toMatchObject({
      claimedAt: "2026-11-07T10:00:00+00:00",
      expiresAt: "2026-11-07T12:00:00+00:00",
      details: {
        profile: { method: "ewallet", provider: "GCash", accountNumber: ACCOUNT_NUMBER },
        updatedAt: "2026-10-02T00:00:00.123456+00:00",
      },
    });
    expect(state.calls).toEqual([
      {
        name: "start_referral_payout",
        args: {
          p_referrer: REFERRER,
          p_reward_ids: [REWARD],
          p_amount_php: 30,
          p_details_updated_at: "2026-10-02T00:00:00+00:00",
          p_admin: ADMIN,
        },
      },
    ]);
    expect(JSON.stringify(consoleCalls)).not.toContain(ACCOUNT_NUMBER);
  });

  it("says who is paying when another admin holds it, and not to send anything", async () => {
    state.results.start_referral_payout = { data: null, error: { code: "DQR07", message: "Another admin is paying" } };
    state.results.referral_payout_conflict = { data: BUSY_CONFLICT, error: null };
    const res = await post(START);
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error).toBe(
      "Being paid by other-admin@example.com since 7 Nov 2026, 10:00 UTC. Don't send anything: wait for them to record it, " +
        "or for their hold to end at 7 Nov 2026, 12:00 UTC.",
    );
  });

  it("says plainly when the rewards were already paid, by whom and when", async () => {
    state.results.start_referral_payout = { data: null, error: { code: "DQR02", message: "changed" } };
    state.results.referral_payout_conflict = { data: PAID_CONFLICT, error: null };
    const res = await post(START);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.refusal).toBe("paid");
    expect(body.error).toContain(
      "already recorded as paid by other-admin@example.com on 7 Nov 2026, 14:05 UTC (1 reward, 30 PHP)",
    );
    expect(body.error).toContain("reconcile with the referrer");
  });

  it.each([
    ["DQR02", 409, "These rewards changed since the page loaded"],
    ["DQR03", 409, "hasn't added payout details yet"],
    ["DQR04", 409, "The payout details changed since the page loaded."],
    ["DQR06", 409, "Your admin account no longer exists, so nothing was started."],
  ])("turns the database's %s into fixed words", async (code, status, text) => {
    state.results.start_referral_payout = { data: null, error: { code, message: `secret ${ACCOUNT_NUMBER}` } };
    state.results.referral_payout_conflict = { data: { claim: null, paid: [] }, error: null };
    const res = await post(START);
    expect(res.status).toBe(status);
    const body = await res.text();
    expect(JSON.parse(body).error).toContain(text);
    expect(body).not.toContain(ACCOUNT_NUMBER);
  });

  it.each([
    ["an amount past what the column holds", { ...START, amountPhp: 2 ** 31 }],
    ["more rewards than a limit allows", { ...START, rewardIds: Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }],
    ["no details version", { ...START, detailsUpdatedAt: undefined }],
  ])("refuses %s with a 400, calling nothing", async (_what, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(state.calls).toEqual([]);
  });
});

describe("POST record: step two (AC 3, AC 5)", () => {
  it("records the payout with exactly what was started, the reference trimmed and the admin from the session", async () => {
    state.results.mark_referral_rewards_paid = { data: "00000000-0000-4000-8000-0000000000e5", error: null };
    const res = await post({ ...GOOD, paidBy: USER });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      payoutId: "00000000-0000-4000-8000-0000000000e5",
      rewardCount: 1,
      amountPhp: 30,
    });
    expect(state.calls).toEqual([
      {
        name: "mark_referral_rewards_paid",
        args: {
          p_referrer: REFERRER,
          p_reward_ids: [REWARD],
          p_amount_php: 30,
          p_details_updated_at: "2026-10-02T00:00:00+00:00",
          p_reference: "abc123",
          p_paid_by: ADMIN,
        },
      },
    ]);
  });

  it("says plainly that a stale tab's rewards were already paid, by whom and when", async () => {
    state.results.mark_referral_rewards_paid = { data: null, error: { code: "DQR02", message: "changed" } };
    state.results.referral_payout_conflict = { data: PAID_CONFLICT, error: null };
    const res = await post(GOOD);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "These rewards were already recorded as paid by other-admin@example.com on 7 Nov 2026, 14:05 UTC (1 reward, 30 PHP). " +
        "Nothing more was recorded. If you also sent money for them, reconcile with the referrer before paying again.",
    );
    expect(state.calls.map((call) => call.name)).toEqual(["mark_referral_rewards_paid", "referral_payout_conflict"]);
  });

  it("still refuses, in plainer words, when who paid can't be read", async () => {
    state.results.mark_referral_rewards_paid = { data: null, error: { code: "DQR02", message: "changed" } };
    state.results.referral_payout_conflict = { data: null, error: { code: "XX000", message: "down" } };
    const res = await post(GOOD);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Nothing was recorded.");
  });

  it.each([
    ["DQR03", 409, "no payout details any more"],
    ["DQR04", 409, "The payout details changed after you started."],
    ["DQR06", 409, "Your admin account no longer exists, so nothing was recorded."],
    ["DQR08", 409, "You no longer hold this payout"],
    ["22023", 400, "Check the reference"],
  ])("turns the database's %s into fixed words", async (code, status, text) => {
    state.results.mark_referral_rewards_paid = { data: null, error: { code, message: `secret ${ACCOUNT_NUMBER}` } };
    const res = await post(GOOD);
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(JSON.parse(body).error).toContain(text);
    expect(body).not.toContain(ACCOUNT_NUMBER);
  });

  it("fails anything else with fixed text, logging only the code", async () => {
    state.results.mark_referral_rewards_paid = { data: null, error: { code: "40P01", message: `secret ${ACCOUNT_NUMBER}` } };
    const res = await post(GOOD);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "The payout couldn't be confirmed. Reload to check whether it was recorded before trying again.",
    });
    expect(consoleCalls).toEqual([["[admin/referrals] payout not recorded", "40P01"]]);
  });

  it.each([
    ["no referrer", { ...GOOD, referrerId: undefined }],
    ["a bad referrer id", { ...GOOD, referrerId: "x" }],
    ["no rewards", { ...GOOD, rewardIds: [] }],
    ["a bad reward id", { ...GOOD, rewardIds: ["x"] }],
    ["a reward twice", { ...GOOD, rewardIds: [REWARD, REWARD] }],
    ["no amount", { ...GOOD, amountPhp: undefined }],
    ["a fractional amount", { ...GOOD, amountPhp: 1.5 }],
    ["an amount past what the column holds", { ...GOOD, amountPhp: 2 ** 31 }],
    ["no details version", { ...GOOD, detailsUpdatedAt: undefined }],
    ["a reference too long", { ...GOOD, reference: "r".repeat(101) }],
    ["a reference with a line break", { ...GOOD, reference: "a\nb" }],
    ["no action", { ...REQUEST }],
    ["an action that doesn't exist", { ...REQUEST, action: "pay" }],
  ])("refuses %s with a 400, calling nothing", async (_what, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.calls).toEqual([]);
  });

  it("refuses a body that isn't JSON, and one too large to be a payout", async () => {
    expect((await post("{not json")).status).toBe(400);
    const large = await post({ ...GOOD, padding: "x".repeat(70_000) });
    expect(large.status).toBe(413);
    expect(large.headers.get("cache-control")).toBe("no-store");
    expect(state.calls).toEqual([]);
  });

  it("sends nothing anywhere: the only call is the database's record (AC 8)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    state.results.mark_referral_rewards_paid = { data: "00000000-0000-4000-8000-0000000000e5", error: null };
    await post(GOOD);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.calls.map((call) => call.name)).toEqual(["mark_referral_rewards_paid"]);
  });
});

describe("POST release", () => {
  it("gives up the admin's own hold", async () => {
    state.results.release_referral_payout = { data: true, error: null };
    const res = await post(RELEASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true });
    expect(state.calls).toEqual([
      { name: "release_referral_payout", args: { p_referrer: REFERRER, p_admin: ADMIN } },
    ]);
  });

  it("says so when there's nothing of theirs to release", async () => {
    state.results.release_referral_payout = { data: false, error: null };
    const res = await post(RELEASE);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("You don't hold this payout any more");
  });

  it("refuses a bad referrer id, calling nothing", async () => {
    expect((await post({ ...RELEASE, referrerId: "x" })).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
});
