import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Address, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import type { HorizonOperation } from "@/lib/stellar/history";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import {
  horizonOperations,
  recordReferralActivity,
  referralActivityFrom,
  supabaseReferralStore,
  syncReferralActivity,
  type ReferralActivity,
  type ReferralActivityStore,
  type ReferralCandidate,
} from "./referral-activity";

const wallet = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const other = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const registry = StrKey.encodeContract(Buffer.alloc(32, 3));
const market = StrKey.encodeContract(Buffer.alloc(32, 4));
const stranger = StrKey.encodeContract(Buffer.alloc(32, 5));
const contracts = [registry, market];
const referredAt = "2026-11-01T10:00:00.123456+00:00";
const hash = (n: number) => n.toString(16).padStart(64, "0");

/** An invocation as Horizon reports it: the contract, the function, its arguments. */
function invoke(overrides: Partial<HorizonOperation> & { contract?: string; fn?: string } = {}): HorizonOperation {
  const { contract = registry, fn = "anchor", ...rest } = overrides;
  return {
    type: "invoke_host_function",
    transaction_successful: true,
    transaction_hash: hash(1),
    created_at: "2026-11-02T10:00:00Z",
    source_account: wallet,
    parameters: [
      { type: "Address", value: Address.fromString(contract).toScVal().toXDR("base64") },
      { type: "Sym", value: xdr.ScVal.scvSymbol(fn).toXDR("base64") },
    ],
    ...rest,
  };
}

const from = (op: HorizonOperation) => referralActivityFrom(op, { wallet, contracts, referredAt });

describe("referralActivityFrom", () => {
  it("counts a successful call by the wallet to a Doqtri contract, naming the function", () => {
    expect(from(invoke())).toEqual({ txHash: hash(1), wallet, fn: "anchor", occurredAt: "2026-11-02T10:00:00Z" });
    expect(from(invoke({ contract: market, fn: "buy" }))?.fn).toBe("buy");
  });

  it("takes a transaction with no successful flag as successful: include_failed=false already left the failed out", () => {
    expect(from(invoke({ transaction_successful: undefined }))).not.toBeNull();
  });

  it("skips every other kind of operation", () => {
    expect(from(invoke({ type: "payment" }))).toBeNull();
    expect(from(invoke({ type: "create_account" }))).toBeNull();
  });

  it("skips a failed transaction", () => {
    expect(from(invoke({ transaction_successful: false }))).toBeNull();
  });

  it("skips another account's operation that merely shows up in the wallet's feed", () => {
    expect(from(invoke({ source_account: other }))).toBeNull();
    expect(from(invoke({ source_account: undefined }))).toBeNull();
  });

  it("skips a contract that isn't Doqtri's", () => {
    expect(from(invoke({ contract: stranger }))).toBeNull();
  });

  it("skips a wallet deployment, which has no contract and function to read", () => {
    expect(from(invoke({ parameters: [] }))).toBeNull();
    expect(from(invoke({ parameters: undefined }))).toBeNull();
    expect(
      from(invoke({ parameters: [{ type: "Bytes", value: nativeToScVal(Buffer.alloc(32, 6)).toXDR("base64") }] })),
    ).toBeNull();
  });

  it("skips parameters that can't be read, without throwing", () => {
    const params = invoke().parameters!;
    expect(from(invoke({ parameters: [{ type: "x", value: "not base64!" }, params[1]] }))).toBeNull();
    expect(from(invoke({ parameters: [params[0], { type: "x", value: "not base64!" }] }))).toBeNull();
    // Valid values of the wrong kind: not an address, not a function name.
    expect(from(invoke({ parameters: [params[1], params[1]] }))).toBeNull();
    expect(
      from(invoke({ parameters: [params[0], { type: "Bytes", value: nativeToScVal(Buffer.alloc(4, 6)).toXDR("base64") }] })),
    ).toBeNull();
  });

  it("skips a call from before the referral was recorded, and counts one from that moment on", () => {
    expect(from(invoke({ created_at: "2026-11-01T09:59:59Z" }))).toBeNull();
    expect(from(invoke({ created_at: "2026-11-01T10:00:01Z" }))).not.toBeNull();
    expect(
      referralActivityFrom(invoke({ created_at: "2026-11-01T10:00:00Z" }), { wallet, contracts, referredAt: "2026-11-01T10:00:00Z" }),
    ).not.toBeNull();
  });

  it("skips a call when either time can't be read", () => {
    expect(from(invoke({ created_at: "not a date" }))).toBeNull();
    expect(referralActivityFrom(invoke(), { wallet, contracts, referredAt: "not a date" })).toBeNull();
  });
});

describe("horizonOperations", () => {
  const body = (records: unknown[]) => new Response(JSON.stringify({ _embedded: { records } }));

  it("reads the wallet's newest operations without failed transactions", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => body([invoke()]));
    const ops = await horizonOperations(fetchImpl)(wallet);
    expect(ops).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(
      new RegExp(`/accounts/${wallet}/operations\\?order=desc&limit=200&include_failed=false$`),
    );
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("takes a 404 as no operations: the account was never funded", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    await expect(horizonOperations(fetchImpl as unknown as typeof fetch)(wallet)).resolves.toEqual([]);
  });

  it("throws on anything else", async () => {
    const answers = [new Response("", { status: 500 }), new Response("", { status: 429 }), new Response("<html>")];
    for (const answer of answers) {
      await expect(horizonOperations((async () => answer) as unknown as typeof fetch)(wallet)).rejects.toThrow();
    }
  });

  it("gives up after the timeout", async () => {
    const hangs = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(horizonOperations(hangs, 5)(wallet)).rejects.toThrow();
  });
});

/** In-memory referral functions: what was recorded and settled, in order. */
function memoryStore(candidates: ReferralCandidate[]) {
  const recorded: { userId: string; activity: ReferralActivity }[] = [];
  const settled: string[] = [];
  const limits: number[] = [];
  const store: ReferralActivityStore = {
    async candidates(limit) {
      limits.push(limit);
      return candidates.slice(0, limit);
    },
    async record(userId, activity) {
      recorded.push({ userId, activity });
    },
    async settle(userId) {
      settled.push(userId);
    },
  };
  return { store, recorded, settled, limits };
}

const gUser = (id: string, g = wallet): ReferralCandidate => ({ user_id: id, referred_at: referredAt, c_wallet: null, g_wallet: g });
const cUser = (id: string): ReferralCandidate => ({
  user_id: id,
  referred_at: referredAt,
  c_wallet: StrKey.encodeContract(Buffer.alloc(32, 8)),
  g_wallet: null,
});

describe("syncReferralActivity", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logged.mockRestore();
  });

  const reader = (answer: (account: string) => Response | Promise<Response>) =>
    horizonOperations((async (url: string) => answer(new URL(url).pathname.split("/")[2])) as unknown as typeof fetch);
  const page = (records: HorizonOperation[]) => new Response(JSON.stringify({ _embedded: { records } }));

  it("records the operations that count for a wallet login, then settles it", async () => {
    const { store, recorded, settled } = memoryStore([gUser("u1")]);
    const summary = await syncReferralActivity(
      store,
      reader(() =>
        page([
          invoke({ transaction_hash: hash(1) }),
          invoke({ transaction_hash: hash(2), contract: stranger }),
          invoke({ transaction_hash: hash(3), source_account: other }),
          invoke({ transaction_hash: hash(4), contract: market, fn: "tip" }),
        ]),
      ),
      contracts,
    );
    expect(recorded.map((r) => [r.userId, r.activity.txHash, r.activity.fn])).toEqual([
      ["u1", hash(1), "anchor"],
      ["u1", hash(4), "tip"],
    ]);
    expect(settled).toEqual(["u1"]);
    expect(summary).toEqual({ synced: 1, failed: 0, skipped: 0 });
  });

  it("reads nothing from Horizon for a passkey user: Horizon has no feed for a contract, so it only settles", async () => {
    const { store, settled, recorded } = memoryStore([cUser("u1")]);
    const fetchImpl = vi.fn();
    const summary = await syncReferralActivity(store, horizonOperations(fetchImpl as unknown as typeof fetch), contracts);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    expect(settled).toEqual(["u1"]);
    expect(summary).toEqual({ synced: 1, failed: 0, skipped: 0 });
  });

  it("a 404 is a wallet with no operations, not a failure", async () => {
    const { store, recorded, settled } = memoryStore([gUser("u1")]);
    const summary = await syncReferralActivity(store, reader(() => new Response("", { status: 404 })), contracts);
    expect(recorded).toEqual([]);
    expect(settled).toEqual(["u1"]);
    expect(summary).toEqual({ synced: 1, failed: 0, skipped: 0 });
  });

  it("a Horizon 500 leaves that user's counts alone, still settles them, and moves on (AC 9)", async () => {
    const { store, recorded, settled } = memoryStore([gUser("bad", other), gUser("good")]);
    const summary = await syncReferralActivity(
      store,
      reader((account) => (account === other ? new Response("", { status: 500 }) : page([invoke()]))),
      contracts,
    );
    expect(recorded.map((r) => r.userId)).toEqual(["good"]);
    expect(settled).toEqual(["bad", "good"]);
    expect(summary).toEqual({ synced: 1, failed: 1, skipped: 0 });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(`could not sync ${other}`));
  });

  it("a Horizon timeout does the same", async () => {
    const { store, recorded, settled } = memoryStore([gUser("slow", other), gUser("good")]);
    const fetchImpl = ((url: string, init: RequestInit) =>
      url.includes(other)
        ? new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
        : Promise.resolve(page([invoke()]))) as unknown as typeof fetch;
    const summary = await syncReferralActivity(store, horizonOperations(fetchImpl, 5), contracts);
    expect(recorded.map((r) => r.userId)).toEqual(["good"]);
    expect(settled).toEqual(["slow", "good"]);
    expect(summary).toEqual({ synced: 1, failed: 1, skipped: 0 });
  });

  it("starts no new user once the budget has gone by, and leaves them for the next run", async () => {
    const { store, settled } = memoryStore([gUser("a"), gUser("b"), gUser("c")]);
    let clock = 0;
    const summary = await syncReferralActivity(
      store,
      async () => {
        clock += 40_000;
        return [];
      },
      contracts,
      { now: () => clock },
    );
    // a at 0 s, b at 40 s, c at 80 s: past the 60 s budget.
    expect(settled).toEqual(["a", "b"]);
    expect(summary).toEqual({ synced: 2, failed: 0, skipped: 1 });
  });

  it("asks for a fixed number of users per run", async () => {
    const { store, limits } = memoryStore([]);
    expect(await syncReferralActivity(store, async () => [], contracts)).toEqual({ synced: 0, failed: 0, skipped: 0 });
    expect(limits).toEqual([25]);
  });

  it("a recording or settling that fails counts as failed, and the next user still runs", async () => {
    const { store, settled } = memoryStore([gUser("a"), gUser("b"), gUser("c")]);
    store.record = async (userId) => {
      if (userId === "a") throw new Error("db down");
    };
    const settle = store.settle;
    store.settle = async (userId) => {
      if (userId === "b") throw new Error("db down");
      await settle(userId);
    };
    const summary = await syncReferralActivity(store, reader(() => page([invoke()])), contracts);
    expect(settled).toEqual(["a", "c"]);
    expect(summary).toEqual({ synced: 1, failed: 2, skipped: 0 });
  });

  it("rejects when the candidates can't be read, which the jobs route catches", async () => {
    const { store } = memoryStore([]);
    store.candidates = async () => {
      throw new Error("db down");
    };
    await expect(syncReferralActivity(store, async () => [], contracts)).rejects.toThrow("db down");
  });
});

const RULES = {
  p_threshold: REFERRAL_ACTIVITY_THRESHOLD,
  p_reward_php: REFERRAL_REWARD_PHP,
  p_default_limit: REFERRAL_REWARD_LIMIT,
};

describe("supabaseReferralStore", () => {
  const activity: ReferralActivity = { txHash: hash(1), wallet, fn: "anchor", occurredAt: "2026-11-02T10:00:00Z" };

  it("passes the network and the program's rules to the functions, which never repeat them", async () => {
    const rpc = vi.fn(async (...call: [string, Record<string, unknown>]) => ({
      data: call[0] === "referral_sync_candidates" ? [gUser("u1")] : null,
      error: null,
    }));
    const store = supabaseReferralStore({ rpc } as never, "testnet");

    expect(await store.candidates(25)).toEqual([gUser("u1")]);
    await store.record("u1", activity);
    await store.settle("u1");

    expect(rpc.mock.calls).toEqual([
      ["referral_sync_candidates", { p_network: "testnet", p_limit: 25 }],
      [
        "record_referral_activity",
        {
          p_user_id: "u1",
          p_network: "testnet",
          p_tx_hash: hash(1),
          p_wallet: wallet,
          p_fn: "anchor",
          p_occurred_at: "2026-11-02T10:00:00Z",
          ...RULES,
        },
      ],
      ["settle_referral_activity", { p_user_id: "u1", p_network: "testnet", ...RULES }],
    ]);
  });

  it("throws what the database refuses, for the sync to count as failed", async () => {
    const store = supabaseReferralStore({ rpc: async () => ({ data: null, error: { message: "nope" } }) } as never, "testnet");
    await expect(store.candidates(25)).rejects.toThrow("nope");
    await expect(store.record("u1", activity)).rejects.toThrow("nope");
    await expect(store.settle("u1")).rejects.toThrow("nope");
  });
});

describe("recordReferralActivity", () => {
  const write = { userId: "u1", txHash: hash(1), wallet, fn: "anchor" };

  it("calls the function with the program's rules and the time it saw the write", async () => {
    const rpc = vi.fn<(...call: [string, Record<string, unknown>]) => Promise<{ error: null }>>(async () => ({ error: null }));
    await recordReferralActivity({ rpc } as never, write);
    expect(rpc).toHaveBeenCalledWith("record_referral_activity", {
      p_user_id: "u1",
      p_network: expect.any(String),
      p_tx_hash: hash(1),
      p_wallet: wallet,
      p_fn: "anchor",
      p_occurred_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      ...RULES,
    });
  });

  it("logs and never throws, when the database refuses or the call itself fails (AC 10)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordReferralActivity({ rpc: async () => ({ error: { message: "refused" } }) } as never, write),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenLastCalledWith(expect.stringContaining(`anchor ${hash(1)} not recorded: refused`));

    await expect(
      recordReferralActivity(
        {
          rpc: () => {
            throw new Error("no network");
          },
        } as never,
        write,
      ),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenLastCalledWith(expect.stringContaining("no network"));
    logged.mockRestore();
  });
});
