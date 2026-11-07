import { beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET_EMAIL_DOMAIN } from "@/lib/wallet-address";

/**
 * GET /api/referrals (WP-4.6, DOQ-24, D-111): the switch, the session, whose
 * rows, and that only masked values leave the server.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000009";
const REFERRED_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const WALLET = "GABC" + "A".repeat(48) + "WXYZ";
const PASSKEY_WALLET = "CDEF" + "B".repeat(48) + "PQRS";
const TX_HASH = "ab".repeat(32);
const FULL_EMAIL = "tycoon.secret@gmail.com";
const SYNTHETIC_EMAIL = `${WALLET.toLowerCase()}@${WALLET_EMAIL_DOMAIN}`;
const VOID_REASON = "the admin's private reason";
const DISPLAY_NAME = "Secret Display Name";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  rpcCalls: [] as [string, Record<string, unknown>][],
  adminUsed: 0,
  serverUsed: 0,
  rows: [] as Record<string, unknown>[],
  rpcError: null as { message: string } | null,
  rewardCount: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => {
    state.serverUsed += 1;
    return { auth: { getUser: async () => ({ data: { user: state.user } }) } };
  },
  createSupabaseAdminClient: () => {
    state.adminUsed += 1;
    return {
      rpc: (name: string, args: Record<string, unknown>) => {
        state.rpcCalls.push([name, args]);
        return {
          range: async (from: number, to: number) =>
            state.rpcError
              ? { data: null, error: state.rpcError }
              : { data: state.rows.slice(from, to + 1), error: null },
        };
      },
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: null, error: null }),
          in: async () => ({ count: state.rewardCount, error: null }),
        };
        return query;
      },
    };
  },
}));
vi.mock("@/lib/stellar/smart-wallet-config", () => ({ NETWORK: "testnet" }));

const { GET } = await import("./route");

const get = (query = "") => GET(new Request(`http://localhost/api/referrals${query}`));

const row = (over: Record<string, unknown>) => ({
  email: null,
  g_wallet: null,
  c_wallet: null,
  referred_at: "2026-11-01T00:00:00Z",
  source: "link",
  activity_count: 0,
  reward_status: null,
  amount_php: null,
  former_user: false,
  ...over,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("LEGAL_OPERATOR_NAME", "Test Operator");
  state.user = { id: ME };
  state.rpcCalls = [];
  state.adminUsed = 0;
  state.serverUsed = 0;
  state.rows = [];
  state.rpcError = null;
  state.rewardCount = 0;
});

describe("while the switch is off", () => {
  it.each([
    ["empty", ""],
    ["blank", "   "],
  ])("answers 404 with it %s, signed in, reading nothing", async (_name, value) => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", value);
    const res = await get();
    expect(res.status).toBe(404);
    expect(state.adminUsed).toBe(0);
    expect(state.rpcCalls).toEqual([]);
  });

  it("answers 404 signed out too, not 401: the route doesn't exist yet", async () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "");
    state.user = null;
    expect((await get()).status).toBe(404);
    expect(state.serverUsed).toBe(0);
  });
});

describe("the session", () => {
  it("answers 401 signed out, reading nothing", async () => {
    state.user = null;
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(state.adminUsed).toBe(0);
  });

  it("reads the caller's rows, on this deployment's network", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.rpcCalls).toEqual([["referral_dashboard", { p_referrer: ME, p_network: "testnet" }]]);
  });

  it("can't be pointed at someone else's by anything in the request", async () => {
    await get(`?user=${OTHER}&referrer=${OTHER}&p_referrer=${OTHER}&user_id=${OTHER}&id=${OTHER}`);
    expect(state.rpcCalls).toEqual([["referral_dashboard", { p_referrer: ME, p_network: "testnet" }]]);
  });
});

describe("the answer", () => {
  it("is never cached", async () => {
    expect((await get()).headers.get("Cache-Control")).toBe("no-store");
  });

  it("holds no raw id, full email, full wallet, hash, name or void reason, whatever a row carries", async () => {
    state.rows = [
      // Every field a careless change to the SQL could bring along.
      row({
        email: FULL_EMAIL,
        c_wallet: PASSKEY_WALLET,
        id: REFERRED_ID,
        referred_user_id: REFERRED_ID,
        referrer_user_id: ME,
        tx_hash: TX_HASH,
        referred_wallet: WALLET,
        display_name: DISPLAY_NAME,
        notes: DISPLAY_NAME,
      }),
      row({ email: SYNTHETIC_EMAIL, g_wallet: WALLET, activity_count: 3, reward_status: "eligible", amount_php: 30 }),
      row({ email: null, c_wallet: PASSKEY_WALLET, reward_status: "void", void_reason: VOID_REASON, amount_php: 30 }),
      row({ former_user: true, activity_count: null, reward_status: "paid", amount_php: 30 }),
    ];
    const res = await get();
    const text = await res.text();

    for (const secret of [
      REFERRED_ID,
      ME,
      FULL_EMAIL,
      "tycoon.secret",
      SYNTHETIC_EMAIL,
      WALLET_EMAIL_DOMAIN,
      WALLET,
      WALLET.toLowerCase(),
      PASSKEY_WALLET,
      TX_HASH,
      VOID_REASON,
      DISPLAY_NAME,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // The shape of anything that would be a leak we didn't name.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(text).not.toMatch(/[GC][A-Z2-7]{55}/);
    expect(text).not.toMatch(/[0-9a-f]{64}/);

    expect(JSON.parse(text).rows).toEqual([
      {
        identity: "ty•••@gmail.com",
        former: false,
        joinedAt: "2026-11-01T00:00:00Z",
        activity: 0,
        status: "pending",
        amountPhp: null,
      },
      {
        identity: "GABC…WXYZ",
        former: false,
        joinedAt: "2026-11-01T00:00:00Z",
        activity: 3,
        status: "eligible",
        amountPhp: 30,
      },
      {
        identity: "CDEF…PQRS",
        former: false,
        joinedAt: "2026-11-01T00:00:00Z",
        activity: 0,
        status: "not_eligible",
        amountPhp: null,
      },
      {
        identity: "Former user",
        former: true,
        joinedAt: "2026-11-01T00:00:00Z",
        activity: null,
        status: "paid",
        amountPhp: 30,
      },
    ]);
  });

  it("carries totals from stored amounts and the limit", async () => {
    state.rows = [
      row({ email: "a@x.com", reward_status: "eligible", amount_php: 30 }),
      row({ email: "b@x.com", reward_status: "paid", amount_php: 45 }),
      row({ email: "c@x.com", reward_status: "over_limit", amount_php: 30 }),
    ];
    state.rewardCount = 30;
    const body = await (await get()).json();
    expect(body.totals).toEqual({ referred: 3, eligible: 1, earnedPhp: 75, unpaidPhp: 30, paidPhp: 45 });
    expect(body.limit).toEqual({ limit: 30, used: 30, reached: true });
    expect(body.payoutNeeded).toBe(true);
  });

  it("pages through the list, from the query string", async () => {
    state.rows = Array.from({ length: 21 }, (_, i) => row({ email: `u${i}@x.com` }));
    expect((await (await get("?page=2")).json()).rows).toHaveLength(1);
    expect((await (await get("?page=nonsense")).json()).rows).toHaveLength(20);
  });

  it("answers 500 when the database fails, saying nothing of why", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.rpcError = { message: "relation details" };
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).not.toContain("relation details");
    log.mockRestore();
  });
});
