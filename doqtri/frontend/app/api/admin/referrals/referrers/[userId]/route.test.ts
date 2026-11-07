import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * PATCH /api/admin/referrals/referrers/[userId] (WP-4.6, DOQ-26): set a referrer's
 * limit (AC 7) through set_referral_reward_limit(), a 404 for anyone but an admin,
 * for an id that isn't one and for no such user (AC 1), never cached.
 */

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const REFERRER = "00000000-0000-4000-8000-0000000000c3";

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  adminUsed: 0,
  calls: [] as { name: string; args: unknown }[],
  error: null as { code?: string; message?: string } | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
  createSupabaseAdminClient: () => {
    state.adminUsed += 1;
    return {
      rpc: async (name: string, args?: unknown) => {
        state.calls.push({ name, args });
        return { data: null, error: state.error };
      },
    };
  },
}));

const { PATCH } = await import("./route");

const patch = (userId: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/admin/referrals/referrers/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId }) },
  );

let consoleCalls: unknown[][] = [];

beforeEach(() => {
  vi.unstubAllEnvs();
  // An admin by wallet, as a wallet login is listed.
  vi.stubEnv("DOQTRI_ADMINS", `G${"A".repeat(55)}`);
  state.user = { id: ADMIN, email: `g${"a".repeat(55)}@stellar.doqtri.local` };
  state.adminUsed = 0;
  state.calls = [];
  state.error = null;
  consoleCalls = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => vi.restoreAllMocks());

it.each([
  ["signed out", null],
  ["a signed-in user", { id: "00000000-0000-4000-8000-0000000000b2", email: "user@example.com" }],
])("is a 404, %s, touching nothing", async (_who, user) => {
  state.user = user;
  const res = await patch(REFERRER, { limit: 31 });
  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(state.adminUsed).toBe(0);
});

it.each(["nope", "00000000-0000-4000-8000-00000000000g"])("is a 404 for an id that isn't one: %s", async (id) => {
  expect((await patch(id, { limit: 31 })).status).toBe(404);
  expect(state.calls).toEqual([]);
});

it("sets the limit with the default from lib/referral-program.ts (AC 7)", async () => {
  const res = await patch(REFERRER, { limit: 31 });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ limit: 31 });
  expect(state.calls).toEqual([
    { name: "set_referral_reward_limit", args: { p_user_id: REFERRER, p_limit: 31, p_default_limit: 30 } },
  ]);
});

it.each([[-1], [1.5], [10_001], ["many"], [null]])("refuses a limit of %j with a 400", async (limit) => {
  const res = await patch(REFERRER, { limit });
  expect(res.status).toBe(400);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(state.calls).toEqual([]);
});

it("is a 404 for a user who doesn't exist", async () => {
  state.error = { code: "23503", message: "violates foreign key" };
  expect((await patch(REFERRER, { limit: 31 })).status).toBe(404);
});

it("fails anything else with fixed text, logging only the code", async () => {
  state.error = { code: "XX000", message: "internal detail" };
  const res = await patch(REFERRER, { limit: 31 });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "The limit couldn't be set." });
  expect(consoleCalls).toEqual([["[admin/referrals] limit not set", "XX000"]]);
});
