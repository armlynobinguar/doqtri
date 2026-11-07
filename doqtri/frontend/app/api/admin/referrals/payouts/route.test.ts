import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET and POST /api/admin/referrals/payouts (WP-4.6, DOQ-26): a 404 for anyone
 * but an admin (AC 1), never cached (AC 9), the queue and the review list, Mark
 * as paid's checks and refusals with fixed text, and payout details never in a
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
};

const GOOD = {
  referrerId: REFERRER,
  rewardIds: [REWARD],
  amountPhp: 30,
  detailsUpdatedAt: "2026-10-02T00:00:00+00:00",
  reference: "  abc123  ",
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
    for (const res of [await get(), await get(`?referrer=${REFERRER}`), await post(GOOD)]) {
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

describe("POST: mark as paid (AC 3, AC 5)", () => {
  it("records the payout with exactly what the admin saw, the reference trimmed and the admin from the session", async () => {
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

  it.each([
    ["DQR02", 409, "These rewards changed since the page loaded."],
    ["DQR03", 409, "This referrer hasn't added payout details yet"],
    ["DQR04", 409, "The payout details changed since the page loaded."],
    ["22023", 400, "Check the reference"],
  ])("turns the database's %s into fixed text", async (code, status, text) => {
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
    ["no details version", { ...GOOD, detailsUpdatedAt: undefined }],
    ["a reference too long", { ...GOOD, reference: "r".repeat(101) }],
    ["a reference with a line break", { ...GOOD, reference: "a\nb" }],
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
