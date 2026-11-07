import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET and POST /api/admin/referrals/testimonials (WP-4.6, DOQ-28, D-113): a 404
 * for anyone but an admin, signed out included, never cached; the list; a
 * decision on the version the admin read, with the database's refusals as fixed
 * words; and no feedback in a log.
 */

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000b2";
const VERSION = "2026-11-07T01:02:03.456789+00:00";
const WORDS = "Mapped my whole roadmap with it.";

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
        const result = Promise.resolve(state.results[name] ?? { data: null, error: null });
        return Object.assign(result, { range: () => result });
      },
    };
  },
}));

const { GET, POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/admin/referrals/testimonials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

let consoleCalls: unknown[][] = [];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("DOQTRI_ADMINS", ADMIN);
  // The admin panel isn't behind the legal pages' switch.
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

describe("who", () => {
  it.each([
    ["signed out", null],
    ["a signed-in user", { id: USER, email: "user@example.com" }],
  ])("is a 404 for both, %s, touching nothing", async (_who, user) => {
    state.user = user;
    for (const res of [await GET(), await post({ userId: USER, version: VERSION, decision: "approve" })]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(state.adminUsed).toBe(0);
  });
});

describe("GET", () => {
  it("lists every testimonial, shaped, never cached, with the switch off", async () => {
    state.results.referral_testimonials_for_review = {
      data: [
        { user_id: USER, name: "Payee Name", feedback: WORDS, consent: true, approved_at: null, rejected_at: null, updated_at: VERSION },
        { user_id: ADMIN, name: null, feedback: "Private words", consent: false, approved_at: null, rejected_at: null, updated_at: VERSION },
      ],
      error: null,
    };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      rows: [
        { userId: USER, name: "Payee Name", feedback: WORDS, status: "pending", version: VERSION },
        { userId: ADMIN, name: null, feedback: "Private words", status: "private", version: VERSION },
      ],
    });
  });

  it("fails with the code only", async () => {
    state.results.referral_testimonials_for_review = { data: null, error: { code: "42P01", message: WORDS } };
    const res = await GET();
    expect(res.status).toBe(500);
    expect(consoleCalls).toEqual([["[admin/referrals] testimonials not loaded", "42P01"]]);
  });
});

describe("POST", () => {
  it("approves the version the admin read, as that admin", async () => {
    state.results.referral_testimonial_review = { data: "approved", error: null };
    const res = await post({ userId: USER, version: VERSION, decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "approved" });
    expect(state.calls).toEqual([
      {
        name: "referral_testimonial_review",
        args: { p_user_id: USER, p_version: VERSION, p_approve: true, p_admin: ADMIN },
      },
    ]);
  });

  it("rejects, the admin coming from the session and never the body", async () => {
    state.results.referral_testimonial_review = { data: "rejected", error: null };
    const res = await post({ userId: USER, version: VERSION, decision: "reject", adminId: USER });
    expect(await res.json()).toEqual({ status: "rejected" });
    expect(state.calls[0].args).toMatchObject({ p_approve: false, p_admin: ADMIN });
  });

  it.each([
    ["changed", "This feedback changed or was removed since the page loaded."],
    ["private", "This feedback isn't shared publicly, so it can't be approved or rejected."],
    ["admin_gone", "Your admin account no longer exists, so nothing was changed."],
  ])("turns %s into a 409 with fixed words", async (result, words) => {
    state.results.referral_testimonial_review = { data: result, error: null };
    const res = await post({ userId: USER, version: VERSION, decision: "approve" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(words);
  });

  it("refuses a malformed request before asking the database", async () => {
    for (const body of ["{nope", { userId: "nope", version: VERSION, decision: "approve" }, { userId: USER, decision: "approve" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post({ userId: USER, version: VERSION, decision: "approve", pad: "x".repeat(5000) })).status).toBe(413);
    expect(state.calls).toEqual([]);
  });

  it("fails with the code only", async () => {
    state.results.referral_testimonial_review = { data: null, error: { code: "XX000", message: WORDS } };
    const res = await post({ userId: USER, version: VERSION, decision: "approve" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "The testimonial couldn't be changed." });
    expect(consoleCalls).toEqual([["[admin/referrals] testimonial not reviewed", "XX000"]]);
  });
});
