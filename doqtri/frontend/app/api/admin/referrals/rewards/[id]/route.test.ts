import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/admin/referrals/rewards/[id] (WP-4.6, DOQ-26): void with a reason and
 * restore (AC 6), a 404 for anyone but an admin and for an id that isn't one
 * (AC 1), never cached, fixed error text.
 */

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const REWARD = "00000000-0000-4000-8000-0000000000d4";

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
      rpc: async (name: string, args?: unknown) => {
        state.calls.push({ name, args });
        return state.results[name] ?? { data: null, error: null };
      },
    };
  },
}));

const { PATCH } = await import("./route");

const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/admin/referrals/rewards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

let consoleCalls: unknown[][] = [];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("DOQTRI_ADMINS", ADMIN);
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

describe("who and which", () => {
  it.each([
    ["signed out", null],
    ["a signed-in user", { id: "00000000-0000-4000-8000-0000000000b2", email: "user@example.com" }],
  ])("is a 404, %s, touching nothing", async (_who, user) => {
    state.user = user;
    const res = await patch(REWARD, { action: "restore" });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.adminUsed).toBe(0);
  });

  it.each(["nope", "1", `${REWARD}0`, "%2e%2e"])("is a 404 for an id that isn't one: %s", async (id) => {
    const res = await patch(id, { action: "restore" });
    expect(res.status).toBe(404);
    expect(state.calls).toEqual([]);
  });
});

describe("void (AC 6)", () => {
  it("voids with the reason, trimmed, and the default limit", async () => {
    state.results.void_referral_reward = { data: true, error: null };
    const res = await patch(REWARD, { action: "void", reason: "  farmed accounts " });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "void" });
    expect(state.calls).toEqual([
      { name: "void_referral_reward", args: { p_reward_id: REWARD, p_reason: "farmed accounts", p_default_limit: 30 } },
    ]);
  });

  it.each([
    ["no reason", { action: "void" }],
    ["a blank reason", { action: "void", reason: "   " }],
    ["a reserved reason", { action: "void", reason: "duplicate_wallet" }],
    ["a reason with a line break", { action: "void", reason: "a\nb" }],
    ["no action", {}],
    ["an action that doesn't exist", { action: "pay" }],
  ])("refuses %s with a 400, calling nothing", async (_what, body) => {
    const res = await patch(REWARD, body);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.calls).toEqual([]);
  });

  it("says so when the reward is paid or already void", async () => {
    state.results.void_referral_reward = { data: false, error: null };
    const res = await patch(REWARD, { action: "void", reason: "fraud" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("can't be voided");
  });
});

describe("restore (AC 6)", () => {
  it.each(["eligible", "over_limit"])("restores to %s, as the limit allows", async (status) => {
    state.results.restore_referral_reward = { data: status, error: null };
    const res = await patch(REWARD, { action: "restore" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status });
    expect(state.calls).toEqual([
      { name: "restore_referral_reward", args: { p_reward_id: REWARD, p_default_limit: 30 } },
    ]);
  });

  it("refuses a reward the database voided, in fixed words", async () => {
    state.results.restore_referral_reward = { data: null, error: { code: "DQR05", message: "This reward can't be restored: duplicate_wallet." } };
    const res = await patch(REWARD, { action: "restore" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "This reward can't be restored: its wallet already earned a reward, or its referrer deleted their account.",
    );
  });

  it("says so when the reward isn't void", async () => {
    state.results.restore_referral_reward = { data: null, error: null };
    expect((await patch(REWARD, { action: "restore" })).status).toBe(409);
  });

  it("fails anything else with fixed text, logging only the code", async () => {
    state.results.restore_referral_reward = { data: null, error: { code: "XX000", message: "internal detail" } };
    const res = await patch(REWARD, { action: "restore" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "The reward couldn't be changed." });
    expect(consoleCalls).toEqual([["[admin/referrals] reward not changed", "XX000"]]);
  });
});
