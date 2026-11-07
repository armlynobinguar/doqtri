import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Referral testimonials' store (WP-4.6, DOQ-28, D-113): the landing page's read
 * stays off, without asking the database or leaving prerendering, until the
 * legal pages are live; once on, it reads on every request and shapes rows to
 * name and text. A save writes only the text and consent, and no feedback
 * deletes the row.
 */

const USER = "00000000-0000-4000-8000-000000000003";

const state = vi.hoisted(() => ({
  connections: 0,
  adminUsed: 0,
  rpc: [] as { name: string; args: unknown }[],
  rpcResult: { data: null as unknown, error: null as { code?: string; message?: string } | null },
  writes: [] as { op: string; row?: unknown; options?: unknown; filters: [string, unknown][]; select?: string }[],
  writeResult: { data: null as unknown, error: null as { code?: string; message?: string } | null },
}));

vi.mock("next/server", () => ({
  connection: async () => {
    state.connections += 1;
  },
}));

function adminClient() {
  return {
    rpc: (name: string, args?: unknown) => {
      state.rpc.push({ name, args });
      const result = Promise.resolve(state.rpcResult);
      return Object.assign(result, { range: () => result });
    },
    from: () => {
      const entry: (typeof state.writes)[number] = { op: "", filters: [] };
      state.writes.push(entry);
      const builder = {
        delete: () => {
          entry.op = "delete";
          return builder;
        },
        upsert: (row: unknown, options: unknown) => {
          entry.op = "upsert";
          entry.row = row;
          entry.options = options;
          return builder;
        },
        select: (columns: string) => {
          entry.select = columns;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          entry.filters.push([column, value]);
          return Promise.resolve(state.writeResult);
        },
        single: async () => state.writeResult,
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: () => {
    state.adminUsed += 1;
    return adminClient();
  },
}));

const store = await import("@/lib/referral-testimonials-store");

/** The fake as the store's parameter types see it: it answers only the calls the store makes. */
const fake = () => adminClient() as never;

let consoleCalls: unknown[][] = [];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
  state.connections = 0;
  state.adminUsed = 0;
  state.rpc = [];
  state.rpcResult = { data: [], error: null };
  state.writes = [];
  state.writeResult = { data: null, error: null };
  consoleCalls = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => vi.restoreAllMocks());

describe("landingTestimonials", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("is empty with the switch %s, asking nothing and staying prerendered", async (_label, value) => {
    if (value === undefined) vi.stubEnv("LEGAL_OPERATOR_NAME", undefined as unknown as string);
    else vi.stubEnv("LEGAL_OPERATOR_NAME", value);
    state.rpcResult = { data: [{ name: "Payee Name", feedback: "Would show if on." }], error: null };
    expect(await store.landingTestimonials()).toEqual([]);
    expect(state.connections).toBe(0);
    expect(state.adminUsed).toBe(0);
    expect(state.rpc).toEqual([]);
  });

  it("once live, reads on every request, as the service role, and returns name and text only", async () => {
    state.rpcResult = {
      data: [
        { name: "Payee Name", feedback: "Great for planning.", user_id: USER, email: "payee@example.com" },
        { name: "Other Payee", feedback: "Mapped my ideas." },
      ],
      error: null,
    };
    expect(await store.landingTestimonials()).toEqual([
      { name: "Payee Name", feedback: "Great for planning." },
      { name: "Other Payee", feedback: "Mapped my ideas." },
    ]);
    expect(state.connections).toBe(1);
    expect(state.rpc).toEqual([{ name: "referral_testimonials_public", args: undefined }]);
  });

  it("shows none rather than break the page when the read fails, logging only the code", async () => {
    state.rpcResult = { data: null, error: { code: "42P01", message: 'relation "Payee Name feedback" does not exist' } };
    expect(await store.landingTestimonials()).toEqual([]);
    expect(consoleCalls).toEqual([["[testimonials] landing page read failed", "42P01"]]);
  });
});

describe("saveTestimonial", () => {
  it("writes only the text and consent, keyed by the session's user, with the service role", async () => {
    state.writeResult = {
      data: { feedback: "Words", consent: true, approved_at: null, rejected_at: null },
      error: null,
    };
    const saved = await store.saveTestimonial(fake(), USER, { feedback: "Words", consent: true });
    expect(saved).toEqual({ feedback: "Words", consent: true, status: "pending" });
    expect(state.writes).toEqual([
      {
        op: "upsert",
        row: { user_id: USER, feedback: "Words", consent: true },
        options: { onConflict: "user_id" },
        filters: [],
        select: "feedback, consent, approved_at, rejected_at",
      },
    ]);
  });

  it("deletes the row when there is no feedback", async () => {
    expect(await store.saveTestimonial(fake(), USER, { feedback: null, consent: false })).toBeNull();
    expect(state.writes).toEqual([{ op: "delete", filters: [["user_id", USER]] }]);
  });

  it("fails with the code only", async () => {
    state.writeResult = { data: null, error: { code: "23514", message: "Failing row contains (Words)" } };
    await expect(store.saveTestimonial(fake(), USER, { feedback: "Words", consent: true })).rejects.toMatchObject({
      name: "TestimonialStoreError",
      code: "23514",
      message: "Saving feedback failed (23514)",
    });
  });
});

describe("reviewTestimonial", () => {
  it("passes the version and the admin through, and returns what the database decided", async () => {
    state.rpcResult = { data: "approved", error: null };
    const version = "2026-11-07T01:02:03.456789+00:00";
    expect(
      await store.reviewTestimonial(fake(), { userId: USER, version, decision: "approve" }, "admin-id"),
    ).toBe("approved");
    expect(state.rpc).toEqual([
      {
        name: "referral_testimonial_review",
        args: { p_user_id: USER, p_version: version, p_approve: true, p_admin: "admin-id" },
      },
    ]);
  });

  it("refuses an answer it doesn't know", async () => {
    state.rpcResult = { data: "published", error: null };
    await expect(
      store.reviewTestimonial(fake(), { userId: USER, version: "2026-11-07T00:00:00Z", decision: "reject" }, "a"),
    ).rejects.toMatchObject({ code: "unknown" });
  });
});
