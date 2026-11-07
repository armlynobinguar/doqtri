import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET and PUT /api/referrals/payout-profile (WP-4.6, DOQ-25, D-112): the switch,
 * the session, eligibility (AC 1), the server's own validation (AC 2, AC 3),
 * whose row is written, that switching method clears the old one (AC 4), and that
 * the details never reach a log or a cache.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000009";
const ADDRESS = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const NAME = "Payout Holder Name";
const MEMO = "memo-77-secret";
const NUMBER = "09998887777";

type Row = Record<string, unknown>;
type Filters = [string, string, unknown][];

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  serverUsed: 0,
  adminUsed: 0,
  /** What the owner's session can read: RLS is the database's job, so this is the row as it would answer. */
  stored: null as Record<string, unknown> | null,
  readError: null as { code: string; message: string } | null,
  eligibleCount: 0,
  eligibilityError: null as { code: string; message: string } | null,
  saves: [] as { row: Record<string, unknown>; options: unknown }[],
  saveError: null as { code: string; message: string; details?: string } | null,
  /** Which client read what, and with which filters. */
  reads: [] as { client: "session" | "admin"; table: string; filters: [string, string, unknown][] }[],
}));

function query(client: "session" | "admin", table: string) {
  const filters: Filters = [];
  state.reads.push({ client, table, filters });
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push(["eq", column, value]);
      return builder;
    },
    in: async (column: string, value: unknown) => {
      filters.push(["in", column, value]);
      return state.eligibilityError
        ? { count: null, error: state.eligibilityError }
        : { count: state.eligibleCount, error: null };
    },
    maybeSingle: async () => (state.readError ? { data: null, error: state.readError } : { data: state.stored, error: null }),
    upsert: async (row: Row, options: unknown) => {
      if (client !== "admin") throw new Error("writes must go through the service role");
      state.saves.push({ row, options });
      return { error: state.saveError };
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
    new Request("http://localhost/api/referrals/payout-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const XLM = { name: NAME, method: "xlm", address: ADDRESS, memo: MEMO };
const EWALLET = {
  name: NAME,
  method: "ewallet",
  provider: "GCash",
  accountName: NAME,
  accountNumber: NUMBER,
  details: "Main branch",
};
const STORED_XLM = {
  method: "xlm",
  name: NAME,
  xlm_address: ADDRESS,
  xlm_memo: MEMO,
  ewallet_provider: null,
  ewallet_account_name: null,
  ewallet_account_number: null,
  ewallet_details: null,
};

/** Every console call, so a test can say none of them carried the details. */
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
  state.eligibilityError = null;
  state.saves = [];
  state.saveError = null;
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
  ])("both answer 404 with it %s, signed in, touching nothing", async (_name, value) => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", value);
    state.stored = STORED_XLM;
    for (const res of [await GET(), await put(XLM)]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).not.toContain(ADDRESS);
    }
    expect(state.serverUsed).toBe(0);
    expect(state.adminUsed).toBe(0);
    expect(state.saves).toEqual([]);
  });

  it("answers 404 signed out too, not 401: the route doesn't exist yet", async () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "");
    state.user = null;
    expect((await GET()).status).toBe(404);
    expect((await put(XLM)).status).toBe(404);
    expect(state.serverUsed).toBe(0);
  });
});

describe("signed out", () => {
  it("both answer 401, never cached, reading and writing nothing", async () => {
    state.user = null;
    for (const res of [await GET(), await put(XLM)]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(state.adminUsed).toBe(0);
    expect(state.reads).toEqual([]);
    expect(state.saves).toEqual([]);
  });
});

describe("eligibility (AC 1)", () => {
  it("is an eligible or paid reward for this referrer on this network, checked with the service role", async () => {
    await GET();
    await put(XLM);
    const checks = state.reads.filter((read) => read.table === "referral_rewards");
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      expect(check.client).toBe("admin");
      expect(check.filters).toEqual([
        ["eq", "referrer_user_id", ME],
        ["eq", "network", "testnet"],
        ["in", "status", ["eligible", "paid"]],
      ]);
    }
  });

  it("PUT answers 403 without one, and saves nothing, whatever the body", async () => {
    state.eligibleCount = 0;
    for (const body of [XLM, EWALLET, { method: "nonsense" }, "not json"]) {
      const res = await put(body);
      expect(res.status).toBe(403);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect((await res.json()).error).toBe("Payout details open once you have an eligible referral.");
    }
    expect(state.saves).toEqual([]);
  });

  it("PUT answers 403 to someone with stored details who no longer qualifies", async () => {
    state.eligibleCount = 0;
    state.stored = STORED_XLM;
    expect((await put(XLM)).status).toBe(403);
    expect(state.saves).toEqual([]);
  });

  it("GET answers 403 to someone with neither an eligible referral nor stored details", async () => {
    state.eligibleCount = 0;
    const res = await GET();
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("GET still shows the owner what's stored once they no longer qualify, read-only", async () => {
    state.eligibleCount = 0;
    state.stored = STORED_XLM;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      profile: { method: "xlm", name: NAME, address: ADDRESS, memo: MEMO },
      canEdit: false,
    });
  });
});

describe("reading", () => {
  it("is nothing saved yet, and the form may be filled in", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ profile: null, canEdit: true });
  });

  it("reads the row through the user's own session, where RLS applies, by the session's id", async () => {
    state.stored = STORED_XLM;
    await GET();
    const read = state.reads.find((r) => r.table === "referral_payout_profiles");
    expect(read).toEqual({ client: "session", table: "referral_payout_profiles", filters: [["eq", "user_id", ME]] });
  });

  it("gives an e-wallet row back in the form's terms", async () => {
    state.stored = {
      method: "ewallet",
      name: NAME,
      xlm_address: null,
      xlm_memo: null,
      ewallet_provider: "Maya",
      ewallet_account_name: NAME,
      ewallet_account_number: NUMBER,
      ewallet_details: null,
    };
    expect((await (await GET()).json()).profile).toEqual({
      method: "ewallet",
      name: NAME,
      provider: "Maya",
      accountName: NAME,
      accountNumber: NUMBER,
      details: null,
    });
  });
});

describe("saving", () => {
  it("stores the session's row, whatever user_id the body names", async () => {
    const res = await put({ ...XLM, user_id: OTHER, userId: OTHER, id: OTHER });
    expect(res.status).toBe(200);
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0].row.user_id).toBe(ME);
    expect(JSON.stringify(state.saves[0].row)).not.toContain(OTHER);
    expect(state.saves[0].options).toEqual({ onConflict: "user_id" });
  });

  it("answers with the masked summary only, never cached", async () => {
    const res = await put(XLM);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ summary: { label: "XLM", last4: ADDRESS.slice(-4) } });
    for (const secret of [ADDRESS, NAME, MEMO]) expect(text).not.toContain(secret);
  });

  it("writes every column, so switching method clears the old one's (AC 4)", async () => {
    await put(XLM);
    await put(EWALLET);
    expect(state.saves[0].row).toMatchObject({
      method: "xlm",
      xlm_address: ADDRESS,
      xlm_memo: MEMO,
      ewallet_provider: null,
      ewallet_account_name: null,
      ewallet_account_number: null,
      ewallet_details: null,
    });
    expect(state.saves[1].row).toMatchObject({
      method: "ewallet",
      xlm_address: null,
      xlm_memo: null,
      ewallet_provider: "GCash",
      ewallet_account_name: NAME,
      ewallet_account_number: NUMBER,
      ewallet_details: "Main branch",
    });
    expect(Object.keys(state.saves[1].row).sort()).toEqual(
      [
        "ewallet_account_name",
        "ewallet_account_number",
        "ewallet_details",
        "ewallet_provider",
        "method",
        "name",
        "updated_at",
        "user_id",
        "xlm_address",
        "xlm_memo",
      ].sort(),
    );
  });

  it("drops the other method's fields sent alongside, rather than store them", async () => {
    await put({ ...EWALLET, address: ADDRESS, memo: MEMO });
    expect(state.saves[0].row).toMatchObject({ method: "ewallet", xlm_address: null, xlm_memo: null });
  });
});

describe("the server's own validation (AC 2, AC 3)", () => {
  it.each([
    ["a passkey C address", { ...XLM, address: "C" + ADDRESS.slice(1) }, "address"],
    ["a bad checksum", { ...XLM, address: ADDRESS.slice(0, -1) + (ADDRESS.endsWith("A") ? "B" : "A") }, "address"],
    ["a 29-byte memo", { ...XLM, memo: "é".repeat(14) + "x" }, "memo"],
    ["no name", { ...XLM, name: " " }, "name"],
    ["no provider", { ...EWALLET, provider: undefined }, "provider"],
    ["no account name", { ...EWALLET, accountName: "" }, "accountName"],
    ["no number", { ...EWALLET, accountNumber: "" }, "accountNumber"],
    ["a line break", { ...EWALLET, accountNumber: "0999\n8887777" }, "accountNumber"],
    ["no method", { name: NAME }, "method"],
  ])("refuses %s with 400, naming the field, saving nothing", async (_name, body, field) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const answer = await res.json();
    expect(answer.error).toBe("Check the highlighted details.");
    expect(Object.keys(answer.fields)).toContain(field);
    expect(state.saves).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["JSON that isn't an object", "[1, 2]"],
    ["nothing at all", ""],
    ["more than any form could be", JSON.stringify({ ...XLM, padding: "x".repeat(9000) })],
  ])("refuses %s with 400, saving nothing", async (_name, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(state.saves).toEqual([]);
  });

  it("never quotes the details back in a refusal", async () => {
    const res = await put({ ...XLM, address: `C${MEMO}`, memo: MEMO.repeat(3), name: `${NAME}\n${NAME}` });
    const text = await res.text();
    for (const secret of [MEMO, NAME]) expect(text).not.toContain(secret);
  });
});

describe("failures, and the logs", () => {
  it("a failed save answers 500 in fixed words and logs the code, never the row", async () => {
    state.saveError = {
      code: "23514",
      message: `new row violates check constraint`,
      details: `Failing row contains (${ME}, xlm, ${NAME}, ${ADDRESS}, ${MEMO}).`,
    };
    const res = await put(XLM);
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Your payout details couldn't be saved." });
    expect(consoleCalls).toEqual([["[referrals] payout details not saved", "23514"]]);
  });

  it("a failed read answers 500 in fixed words and logs the code only", async () => {
    state.readError = { code: "42501", message: `permission denied: ${ADDRESS}` };
    const res = await GET();
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Your payout details couldn't be loaded." });
    expect(consoleCalls).toEqual([["[referrals] payout details not loaded", "42501"]]);
  });

  it("a code that isn't one is logged as unknown, so nothing else can ride in it", async () => {
    state.eligibilityError = { code: `${NAME} ${ADDRESS}`, message: "x" };
    expect((await put(XLM)).status).toBe(500);
    expect(consoleCalls).toEqual([["[referrals] payout details not saved", "unknown"]]);
  });

  it("nothing anywhere logs the details, across every answer the routes give", async () => {
    await GET();
    await put(XLM);
    await put(EWALLET);
    await put({ ...XLM, address: "C" + ADDRESS.slice(1) });
    await put("{");
    state.stored = STORED_XLM;
    await GET();
    state.eligibleCount = 0;
    await put(XLM);
    await GET();
    state.eligibleCount = 1;
    state.saveError = { code: "XX000", message: `${NAME} ${ADDRESS} ${MEMO} ${NUMBER}` };
    await put(EWALLET);
    state.readError = { code: "XX000", message: `${NAME} ${ADDRESS} ${MEMO} ${NUMBER}` };
    await GET();

    const logged = JSON.stringify(consoleCalls);
    for (const secret of [NAME, ADDRESS, MEMO, NUMBER, "Main branch"]) expect(logged).not.toContain(secret);
    expect(consoleCalls.length).toBeGreaterThan(0);
  });
});
