import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET and PUT /api/referrals/testimonial (WP-4.6, DOQ-28, D-113): the switch,
 * the session, eligibility like the questionnaire's, the server's own checks,
 * whose row is written, that withdrawing is never refused, and that feedback
 * never reaches a log or a cache.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000009";
const WORDS = "I mapped a whole launch plan in an afternoon.";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  serverUsed: 0,
  adminUsed: 0,
  stored: null as Record<string, unknown> | null,
  readError: null as { code: string; message: string } | null,
  eligibleCount: 0,
  writes: [] as { client: string; op: string; row?: Record<string, unknown>; filters: [string, unknown][] }[],
  writeError: null as { code: string; message: string } | null,
  reads: [] as { client: string; table: string; filters: [string, unknown][] }[],
}));

function query(client: "session" | "admin", table: string) {
  const filters: [string, unknown][] = [];
  state.reads.push({ client, table, filters });
  let write: (typeof state.writes)[number] | null = null;
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      if (write?.op === "delete") {
        write.filters.push([column, value]);
        return Promise.resolve({ error: state.writeError });
      }
      return builder;
    },
    in: async () => ({ count: state.eligibleCount, error: null }),
    maybeSingle: async () => (state.readError ? { data: null, error: state.readError } : { data: state.stored, error: null }),
    upsert: (row: Record<string, unknown>) => {
      if (client !== "admin") throw new Error("writes must go through the service role");
      write = { client, op: "upsert", row, filters: [] };
      state.writes.push(write);
      return builder;
    },
    delete: () => {
      if (client !== "admin") throw new Error("writes must go through the service role");
      write = { client, op: "delete", filters: [] };
      state.writes.push(write);
      return builder;
    },
    single: async () =>
      state.writeError
        ? { data: null, error: state.writeError }
        : {
            data: { feedback: write?.row?.feedback, consent: write?.row?.consent, approved_at: null, rejected_at: null },
            error: null,
          },
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => {
    state.serverUsed += 1;
    return {
      auth: { getUser: async () => ({ data: { user: state.user } }) },
      from: (table: string) => query("session", table),
    };
  },
  createSupabaseAdminClient: () => {
    state.adminUsed += 1;
    return { from: (table: string) => query("admin", table) };
  },
}));
vi.mock("@/lib/stellar/smart-wallet-config", () => ({ NETWORK: "testnet" }));

const { GET, PUT } = await import("./route");

const put = (body: unknown) =>
  PUT(
    new Request("http://localhost/api/referrals/testimonial", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const STORED = { feedback: WORDS, consent: true, approved_at: "2026-11-07T01:00:00Z", rejected_at: null };

let consoleCalls: unknown[][] = [];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
  state.user = { id: ME };
  state.serverUsed = 0;
  state.adminUsed = 0;
  state.stored = null;
  state.readError = null;
  state.eligibleCount = 1;
  state.writes = [];
  state.writeError = null;
  state.reads = [];
  consoleCalls = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => vi.restoreAllMocks());

describe("while the switch is off", () => {
  it.each([
    ["empty", ""],
    ["blank", "   "],
  ])("both answer 404 with it %s, signed in or not, touching nothing", async (_label, value) => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", value);
    state.stored = STORED;
    for (const user of [{ id: ME }, null]) {
      state.user = user;
      for (const res of [await GET(), await put({ feedback: WORDS, consent: true })]) {
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ error: "Not found" });
      }
    }
    expect(state.serverUsed + state.adminUsed).toBe(0);
    expect(state.writes).toEqual([]);
  });
});

describe("signed out", () => {
  it("is a 401 for both, reading nothing and writing nothing", async () => {
    state.user = null;
    for (const res of [await GET(), await put({ feedback: WORDS, consent: true })]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(state.adminUsed).toBe(0);
    expect(state.writes).toEqual([]);
  });
});

describe("GET", () => {
  it("returns the user's own testimonial, through their session, with where it stands", async () => {
    state.stored = STORED;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ testimonial: { feedback: WORDS, consent: true, status: "approved" }, canEdit: true });
    expect(state.reads.find((r) => r.table === "referral_testimonials")).toEqual({
      client: "session",
      table: "referral_testimonials",
      filters: [["user_id", ME]],
    });
  });

  it("is a 403 with neither an eligible referral nor anything stored", async () => {
    state.eligibleCount = 0;
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("still shows what's stored without an eligible referral, as read-only", async () => {
    state.eligibleCount = 0;
    state.stored = STORED;
    expect(await (await GET()).json()).toMatchObject({ canEdit: false });
  });

  it("fails without quoting the database", async () => {
    state.readError = { code: "42P01", message: `relation for "${WORDS}"` };
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(consoleCalls)).not.toContain(WORDS);
    expect(consoleCalls).toEqual([["[referrals] feedback not loaded", "42P01"]]);
  });
});

describe("PUT", () => {
  it("saves feedback and consent for the session's user only, whatever the body says", async () => {
    const res = await put({ feedback: `  ${WORDS} `, consent: true, user_id: OTHER, approved_at: "2026-11-07T00:00:00Z" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ testimonial: { feedback: WORDS, consent: true, status: "pending" } });
    expect(state.writes).toEqual([
      { client: "admin", op: "upsert", row: { user_id: ME, feedback: WORDS, consent: true }, filters: [] },
    ]);
  });

  it("deletes the row when the feedback is cleared", async () => {
    const res = await put({ feedback: "", consent: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ testimonial: null });
    expect(state.writes).toEqual([{ client: "admin", op: "delete", filters: [["user_id", ME]] }]);
  });

  it("checks the feedback itself, saving nothing when it's wrong", async () => {
    const res = await put({ feedback: "x".repeat(501), consent: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Check the highlighted details.",
      fields: { feedback: "Use 500 characters or fewer." },
    });
    expect((await (await put({ feedback: "", consent: true })).json()).fields).toEqual({
      consent: "Write your feedback to share it, or untick this.",
    });
    expect(state.writes).toEqual([]);
  });

  it("refuses what isn't JSON, and what's too big to be the form", async () => {
    expect((await put("{not json")).status).toBe(400);
    expect((await put({ feedback: "x".repeat(5000) })).status).toBe(413);
    expect(state.writes).toEqual([]);
  });

  it("is a 403 without an eligible referral and nothing stored", async () => {
    state.eligibleCount = 0;
    const res = await put({ feedback: WORDS, consent: true });
    expect(res.status).toBe(403);
    expect(state.writes).toEqual([]);
  });

  describe("without an eligible referral but with a testimonial stored", () => {
    beforeEach(() => {
      state.eligibleCount = 0;
      state.stored = STORED;
    });

    it("lets the user withdraw consent, keeping the words", async () => {
      const res = await put({ feedback: WORDS, consent: false });
      expect(res.status).toBe(200);
      expect(state.writes).toEqual([
        { client: "admin", op: "upsert", row: { user_id: ME, feedback: WORDS, consent: false }, filters: [] },
      ]);
    });

    it("lets the user delete it", async () => {
      expect((await put({ feedback: "", consent: false })).status).toBe(200);
      expect(state.writes).toEqual([{ client: "admin", op: "delete", filters: [["user_id", ME]] }]);
    });

    it("but not write new words, or opt in", async () => {
      expect((await put({ feedback: "New words", consent: false })).status).toBe(403);
      expect((await put({ feedback: WORDS, consent: true })).status).toBe(403);
      expect(state.writes).toEqual([]);
    });
  });

  it("fails without quoting the database or the feedback", async () => {
    state.writeError = { code: "23514", message: `new row violates check: ${WORDS}` };
    const res = await put({ feedback: WORDS, consent: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Your feedback couldn't be saved." });
    expect(JSON.stringify(consoleCalls)).not.toContain(WORDS);
    expect(consoleCalls).toEqual([["[referrals] feedback not saved", "23514"]]);
  });
});
