import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Address, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import type { HorizonOperation } from "@/lib/stellar/history";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_LIMIT, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import { CONTRACT_ID, HORIZON_URL } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import {
  horizonOperations,
  recordReferralActivity,
  referralActivityFrom,
  runReferralSync,
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

type FeedOp = HorizonOperation & { function?: string };

/** An invocation as Horizon reports it: the contract, the function, its arguments. */
function invoke(overrides: Partial<FeedOp> & { contract?: string; fn?: string } = {}): FeedOp {
  const { contract = registry, fn = "anchor", ...rest } = overrides;
  return {
    type: "invoke_host_function",
    transaction_successful: true,
    transaction_hash: hash(1),
    created_at: "2026-11-02T10:00:00Z",
    source_account: wallet,
    function: "HostFunctionTypeHostFunctionTypeInvokeContract",
    parameters: [
      { type: "Address", value: Address.fromString(contract).toScVal().toXDR("base64") },
      { type: "Sym", value: xdr.ScVal.scvSymbol(fn).toXDR("base64") },
    ],
    ...rest,
  };
}

const from = (op: FeedOp) => referralActivityFrom(op, { wallet, contracts, referredAt });

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

  it("skips a deployment, even when its constructor's arguments read like a call to Doqtri", () => {
    // As testnet's Horizon reports them: type invoke_host_function, a `function`
    // naming the deployment, and `parameters` holding the constructor's arguments.
    const looksLikeACall = invoke().parameters;
    const asReported = [
      { type: "Address", value: Address.fromString(other).toScVal().toXDR("base64") },
      { type: "Address", value: Address.fromString(wallet).toScVal().toXDR("base64") },
    ];
    for (const parameters of [looksLikeACall, asReported]) {
      expect(from(invoke({ function: "HostFunctionTypeHostFunctionTypeCreateContractV2", parameters }))).toBeNull();
    }
    expect(from(invoke({ function: "HostFunctionTypeHostFunctionTypeCreateContract", parameters: undefined }))).toBeNull();
    expect(
      from(
        invoke({
          function: "HostFunctionTypeHostFunctionTypeUploadContractWasm",
          parameters: [{ type: "Bytes", value: nativeToScVal(Buffer.alloc(32, 6)).toXDR("base64") }],
        }),
      ),
    ).toBeNull();
  });

  it("skips an operation that doesn't say which host function it ran", () => {
    expect(from(invoke({ function: undefined }))).toBeNull();
  });

  it("skips a call with no contract and function to read", () => {
    expect(from(invoke({ parameters: [] }))).toBeNull();
    expect(from(invoke({ parameters: undefined }))).toBeNull();
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
  const since = "2026-11-01T10:00:00Z";
  const next = (n: number) => `https://horizon.test/next-${n}`;
  const records = (count: number, created_at = "2026-11-02T10:00:00Z") =>
    Array.from({ length: count }, () => invoke({ created_at }));
  const body = (ops: unknown[], nextHref?: string) =>
    new Response(JSON.stringify({ _embedded: { records: ops }, _links: { next: { href: nextHref } } }));
  /** A feed answering each request with the next page, recording what was asked. */
  const feed = (...pages: Response[]) => vi.fn<typeof fetch>(async () => pages.shift() ?? new Response("", { status: 500 }));

  it("reads the wallet's newest operations without failed transactions", async () => {
    const fetchImpl = feed(body(records(1)));
    const ops = await horizonOperations(fetchImpl)(wallet, since);
    expect(ops).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(
      new RegExp(`/accounts/${wallet}/operations\\?order=desc&limit=200&include_failed=false$`),
    );
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("takes a 404 as no operations: the account was never funded", async () => {
    await expect(horizonOperations(feed(new Response("", { status: 404 })))(wallet, since)).resolves.toEqual([]);
  });

  it("throws on anything else", async () => {
    const answers = [new Response("", { status: 500 }), new Response("", { status: 429 }), new Response("<html>")];
    for (const answer of answers) {
      await expect(horizonOperations(feed(answer))(wallet, since)).rejects.toThrow();
    }
  });

  it("gives up after the timeout", async () => {
    const hangs = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(horizonOperations(hangs, 5)(wallet, since)).rejects.toThrow();
  });

  it("follows Horizon's next link through a full page", async () => {
    const fetchImpl = feed(body(records(200), next(1)), body(records(3), next(2)));
    const ops = await horizonOperations(fetchImpl)(wallet, since);
    expect(ops).toHaveLength(203);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))[1]).toBe(next(1));
  });

  it("stops at a page that isn't full: there is nothing older", async () => {
    const fetchImpl = feed(body(records(3), next(1)));
    await horizonOperations(fetchImpl)(wallet, since);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops once operations are older than the referral", async () => {
    const page = [...records(199), invoke({ created_at: "2026-11-01T09:59:59Z" })];
    const fetchImpl = feed(body(page, next(1)), body(records(200), next(2)));
    await horizonOperations(fetchImpl)(wallet, since);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads three pages at most", async () => {
    const fetchImpl = feed(
      body(records(200), next(1)),
      body(records(200), next(2)),
      body(records(200), next(3)),
      body(records(200), next(4)),
    );
    const ops = await horizonOperations(fetchImpl)(wallet, since);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(ops).toHaveLength(600);
  });

  it("gives every page the same timeout, so the pages together stay inside it", async () => {
    const fetchImpl = feed(body(records(200), next(1)), body(records(1)));
    await horizonOperations(fetchImpl)(wallet, since);
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(fetchImpl.mock.calls[1][1]?.signal);
  });

  it("drops the pages it has when a later one fails, leaving the counts alone", async () => {
    await expect(
      horizonOperations(feed(body(records(200), next(1)), new Response("", { status: 500 })))(wallet, since),
    ).rejects.toThrow("500");
  });

  it("finds calls hidden behind a full page of newer operations", async () => {
    const noise = Array.from({ length: 200 }, () => invoke({ type: "payment", created_at: "2026-11-03T10:00:00Z" }));
    const real = [hash(1), hash(2), hash(3)].map((transaction_hash) => invoke({ transaction_hash }));
    const { store, recorded } = memoryStore([gUser("u1")]);
    await syncReferralActivity(store, horizonOperations(feed(body(noise, next(1)), body(real))), contracts);
    expect(recorded.map((r) => r.activity.txHash)).toEqual([hash(1), hash(2), hash(3)]);
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

describe("runReferralSync", () => {
  const gWalletRow = { user_id: "u1", referred_at: referredAt, c_wallet: null, g_wallet: wallet };
  const cWalletRow = { user_id: "u2", referred_at: referredAt, c_wallet: stranger, g_wallet: null };

  function admin(candidates: unknown[], candidatesError: { message: string } | null = null) {
    const rpc = vi.fn(async (...call: [string, Record<string, unknown>]) =>
      call[0] === "referral_sync_candidates" ? { data: candidates, error: candidatesError } : { data: null, error: null },
    );
    return { rpc };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wires the database, Horizon and Doqtri's contracts together", async () => {
    const fetchStub = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            _embedded: {
              records: [
                invoke({ contract: CONTRACT_ID, fn: "anchor", transaction_hash: hash(7) }),
                invoke({ contract: stranger, transaction_hash: hash(8) }),
              ],
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchStub);
    const client = admin([gWalletRow, cWalletRow]);

    await expect(runReferralSync(client as never)).resolves.toEqual({ synced: 2, failed: 0, skipped: 0 });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(String(fetchStub.mock.calls[0][0])).toContain(`${HORIZON_URL}/accounts/${wallet}/operations?`);
    expect(client.rpc.mock.calls.map((call) => call[0])).toEqual([
      "referral_sync_candidates",
      "record_referral_activity",
      "settle_referral_activity",
      "settle_referral_activity",
    ]);
    expect(client.rpc.mock.calls[0][1]).toEqual({ p_network: NETWORK, p_limit: 25, p_min_resync_seconds: 900 });
    expect(client.rpc.mock.calls[1][1]).toMatchObject({
      p_user_id: "u1",
      p_network: NETWORK,
      p_tx_hash: hash(7),
      p_wallet: wallet,
      p_fn: "anchor",
      p_threshold: REFERRAL_ACTIVITY_THRESHOLD,
    });
    expect(client.rpc.mock.calls[2][1]).toMatchObject({ p_user_id: "u1", p_network: NETWORK });
    expect(client.rpc.mock.calls[3][1]).toMatchObject({ p_user_id: "u2", p_network: NETWORK });
  });

  it("rejects when the database can't list candidates, for the jobs route to catch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(runReferralSync(admin([], { message: "db down" }) as never)).rejects.toThrow("db down");
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
      ["referral_sync_candidates", { p_network: "testnet", p_limit: 25, p_min_resync_seconds: 900 }],
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
