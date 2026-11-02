import { afterEach, describe, expect, it, vi } from "vitest";
import { hash, StrKey } from "@stellar/stellar-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retryDelayMs } from "@/lib/stellar/chain-jobs";
import { TOP_UP_BELOW_STROOPS } from "@/lib/stellar/friendbot-topup";
import {
  MAX_TOPUP_RETRIES,
  processWalletTopUps,
  supabaseWalletTopUpStore,
  topUpNewWallet,
  type NewWallet,
  type TopUpDeps,
  type TopUpUpdate,
  type WalletTopUpStore,
} from "@/lib/stellar/wallet-topups";

const wallet: NewWallet = { userId: "u1", address: StrKey.encodeContract(hash(Buffer.from("new wallet"))) };
const txHash = "cd".repeat(32);

type Row = { id: string; user_id: string; address: string; attempts: number; claim_token: string | null; status: TopUpUpdate["status"]; next_attempt_at: Date; last_error: string | null; tx_hash: string | null };

/** wallet_topups in memory, claimed and finished as claim_wallet_topups() and the server's update do. */
function memoryStore(clock: { now: Date }) {
  const rows: Row[] = [];
  let tokens = 0;
  const store: WalletTopUpStore & { rows: Row[] } = {
    rows,
    async enqueue(w, error) {
      if (rows.some((r) => r.address === w.address && r.status === "pending")) return;
      rows.push({
        id: `t${rows.length + 1}`,
        user_id: w.userId,
        address: w.address,
        attempts: 0,
        claim_token: null,
        status: "pending",
        next_attempt_at: new Date(clock.now.getTime() + 60_000),
        last_error: error,
        tx_hash: null,
      });
    },
    async claim(limit) {
      return rows
        .filter((r) => r.status === "pending" && r.next_attempt_at <= clock.now)
        .slice(0, limit)
        .map((r) => {
          r.attempts++;
          r.next_attempt_at = new Date(clock.now.getTime() + 120_000);
          r.claim_token = `k${++tokens}`;
          return { id: r.id, user_id: r.user_id, address: r.address, attempts: r.attempts, claim_token: r.claim_token };
        });
    },
    async finish(item, update) {
      const row = rows.find((r) => r.id === item.id && r.claim_token === item.claim_token);
      if (!row) return false;
      Object.assign(row, { ...update, claim_token: null });
      if (update.next_attempt_at) row.next_attempt_at = new Date(update.next_attempt_at);
      return true;
    },
  };
  return store;
}

function friendbot(results: ("busy" | "ok")[]) {
  const calls: string[] = [];
  const topUp = async (address: string) => {
    calls.push(address);
    if ((results.shift() ?? "busy") === "busy") throw new Error("Friendbot is busy. Try again in a minute.");
    return { hash: txHash };
  };
  return { calls, topUp };
}

afterEach(() => vi.restoreAllMocks());

describe("topUpNewWallet (the relay's first try)", () => {
  it("queues a retry when Friendbot refuses and the deploy lands", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore({ now: new Date("2026-11-01T12:00:00Z") });
    await topUpNewWallet(wallet, Promise.resolve({ hash: "deploy" }), store, { mainnet: false, topUp: friendbot(["busy"]).topUp });
    expect(store.rows).toEqual([
      expect.objectContaining({ address: wallet.address, user_id: "u1", status: "pending", attempts: 0, last_error: "Friendbot is busy. Try again in a minute." }),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/retry queued/));
  });

  it("queues nothing when the first try lands", async () => {
    const store = memoryStore({ now: new Date() });
    await topUpNewWallet(wallet, Promise.resolve(), store, { mainnet: false, topUp: friendbot(["ok"]).topUp });
    expect(store.rows).toEqual([]);
  });

  it("queues nothing when the deploy failed too: there is no wallet to fill", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = memoryStore({ now: new Date() });
    const deployed = Promise.reject(new Error("txFailed"));
    deployed.catch(() => {});
    await topUpNewWallet(wallet, deployed, store, { mainnet: false, topUp: friendbot(["busy"]).topUp });
    expect(store.rows).toEqual([]);
  });

  it("never throws, even when the retry cannot be queued", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = { enqueue: async () => Promise.reject(new Error("db down")) };
    await expect(topUpNewWallet(wallet, Promise.resolve(), store, { mainnet: false, topUp: friendbot(["busy"]).topUp })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/no retry could be queued: db down/));
  });

  it("does nothing on mainnet", async () => {
    const store = memoryStore({ now: new Date() });
    const bot = friendbot(["busy"]);
    await topUpNewWallet(wallet, Promise.resolve(), store, { mainnet: true, topUp: bot.topUp });
    expect(bot.calls).toEqual([]);
    expect(store.rows).toEqual([]);
  });
});

describe("processWalletTopUps (the chain jobs run)", () => {
  async function queued(clock: { now: Date }) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore(clock);
    await store.enqueue(wallet, "Friendbot is busy. Try again in a minute.");
    return store;
  }
  const deps = (clock: { now: Date }, topUp: TopUpDeps["topUp"], balance = async () => BigInt(0)): TopUpDeps => ({
    mainnet: false,
    topUp,
    balance,
    now: () => clock.now,
  });
  const advance = (clock: { now: Date }, ms: number) => (clock.now = new Date(clock.now.getTime() + ms));

  it("retries a queued top-up with backoff and marks it done once it lands", async () => {
    const clock = { now: new Date("2026-11-01T12:00:00Z") };
    const store = await queued(clock);
    const bot = friendbot(["busy", "busy", "ok"]);

    expect(await processWalletTopUps(store, deps(clock, bot.topUp))).toMatchObject({ pending: 0, done: 0 });
    expect(bot.calls).toHaveLength(0); // not due for a minute after the first failure

    advance(clock, 60_000);
    expect(await processWalletTopUps(store, deps(clock, bot.topUp))).toEqual({ skipped: false, done: 0, pending: 1, failed: 0 });
    expect(store.rows[0].next_attempt_at.getTime() - clock.now.getTime()).toBe(retryDelayMs(1));

    advance(clock, retryDelayMs(1) - 1);
    await processWalletTopUps(store, deps(clock, bot.topUp));
    expect(bot.calls).toHaveLength(1); // still backing off

    advance(clock, 1);
    expect(await processWalletTopUps(store, deps(clock, bot.topUp))).toMatchObject({ pending: 1 });
    expect(store.rows[0].next_attempt_at.getTime() - clock.now.getTime()).toBe(retryDelayMs(2));

    advance(clock, retryDelayMs(2));
    expect(await processWalletTopUps(store, deps(clock, bot.topUp))).toEqual({ skipped: false, done: 1, pending: 0, failed: 0 });
    expect(store.rows[0]).toMatchObject({ status: "done", tx_hash: txHash, last_error: null, attempts: 3 });
    expect(bot.calls).toEqual([wallet.address, wallet.address, wallet.address]);

    advance(clock, 60 * 60_000);
    await processWalletTopUps(store, deps(clock, bot.topUp));
    expect(bot.calls).toHaveLength(3);
  });

  it("marks a wallet that already has plenty done without asking Friendbot", async () => {
    const clock = { now: new Date("2026-11-01T12:00:00Z") };
    const store = await queued(clock);
    const bot = friendbot(["ok"]);
    advance(clock, 60_000);
    await processWalletTopUps(store, deps(clock, bot.topUp, async () => TOP_UP_BELOW_STROOPS));
    expect(store.rows[0]).toMatchObject({ status: "done", tx_hash: null });
    expect(bot.calls).toEqual([]);
  });

  it("gives up after the retry cap: marked failed, logged once, never retried again", async () => {
    const clock = { now: new Date("2026-11-01T12:00:00Z") };
    const store = await queued(clock);
    const bot = friendbot([]);
    const warn = vi.mocked(console.warn);
    warn.mockClear();

    const totals = { done: 0, pending: 0, failed: 0 };
    for (let run = 0; run < 200; run++) {
      advance(clock, 60_000);
      const summary = await processWalletTopUps(store, deps(clock, bot.topUp));
      totals.done += summary.done;
      totals.pending += summary.pending;
      totals.failed += summary.failed;
    }

    expect(bot.calls).toHaveLength(MAX_TOPUP_RETRIES);
    expect(totals).toEqual({ done: 0, pending: MAX_TOPUP_RETRIES - 1, failed: 1 });
    expect(store.rows[0]).toMatchObject({ status: "failed", attempts: MAX_TOPUP_RETRIES, last_error: "Friendbot is busy. Try again in a minute." });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`gave up topping up ${wallet.address} after ${MAX_TOPUP_RETRIES} retries`)));
  });

  it("leaves a retry a later run claimed to that run, unlogged", async () => {
    const clock = { now: new Date("2026-11-01T12:00:00Z") };
    const store = await queued(clock);
    advance(clock, 60_000);
    const stale: WalletTopUpStore = { ...store, finish: async () => false };
    const summary = await processWalletTopUps(stale, deps(clock, async () => ({ hash: txHash })));
    expect(summary).toEqual({ skipped: false, done: 0, pending: 1, failed: 0 });
  });

  it("claims nothing and sends nothing on mainnet", async () => {
    const clock = { now: new Date("2026-11-01T12:00:00Z") };
    const store = await queued(clock);
    advance(clock, 60_000);
    const claim = vi.spyOn(store, "claim");
    const bot = friendbot(["ok"]);
    expect(await processWalletTopUps(store, { ...deps(clock, bot.topUp), mainnet: true })).toEqual({ skipped: true, done: 0, pending: 0, failed: 0 });
    expect(claim).not.toHaveBeenCalled();
    expect(bot.calls).toEqual([]);
  });
});

describe("supabaseWalletTopUpStore", () => {
  function fakeAdmin(insertError: { code: string; message: string } | null) {
    const inserted: unknown[] = [];
    const admin = {
      from: () => ({
        insert: async (row: unknown) => {
          inserted.push(row);
          return { error: insertError };
        },
      }),
    } as unknown as SupabaseClient;
    return { admin, inserted };
  }

  it("queues the wallet with its user and the first error", async () => {
    const { admin, inserted } = fakeAdmin(null);
    await supabaseWalletTopUpStore(admin).enqueue(wallet, "busy");
    expect(inserted).toEqual([{ user_id: "u1", address: wallet.address, last_error: "busy" }]);
  });

  it("counts a retry already open for the wallet as queued", async () => {
    const { admin } = fakeAdmin({ code: "23505", message: "duplicate key" });
    await expect(supabaseWalletTopUpStore(admin).enqueue(wallet, "busy")).resolves.toBeUndefined();
  });

  it("throws any other error", async () => {
    const { admin } = fakeAdmin({ code: "42501", message: "permission denied" });
    await expect(supabaseWalletTopUpStore(admin).enqueue(wallet, "busy")).rejects.toThrow("permission denied");
  });
});
