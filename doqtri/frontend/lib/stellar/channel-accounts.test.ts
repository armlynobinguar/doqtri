import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  channelKeypair,
  fundingNeeded,
  seedRelayChannels,
  TESTNET_REFILL_BELOW_XLM,
  type ChannelRow,
} from "@/lib/stellar/channel-accounts.mjs";

const seed = "a-test-relay-channel-seed-of-40-chars-xx";

describe("channelKeypair", () => {
  it("gives the same keypair for the same seed, network and index", () => {
    const a = channelKeypair(seed, "testnet", 3);
    const b = channelKeypair(seed, "testnet", 3);
    expect(a.secret()).toBe(b.secret());
    expect(StrKey.isValidEd25519PublicKey(a.publicKey())).toBe(true);
  });

  it("is pinned: a derivation change would orphan every funded channel", () => {
    // HMAC-SHA256(seed, "doqtri-relay-channel:testnet:0") as a raw ed25519 seed.
    expect(channelKeypair(seed, "testnet", 0).publicKey()).toBe("GAVODUZB6EHFKHY3WLAZGKRKAOYYH5NLY22V2JEULWWCEFMOZAVFWXLI");
  });

  it("gives a different account per index, network and seed", () => {
    const keys = new Set([
      channelKeypair(seed, "testnet", 0).publicKey(),
      channelKeypair(seed, "testnet", 1).publicKey(),
      channelKeypair(seed, "mainnet", 0).publicKey(),
      channelKeypair(`${seed}y`, "testnet", 0).publicKey(),
    ]);
    expect(keys.size).toBe(4);
  });

  it("refuses a short seed and a bad index", () => {
    expect(() => channelKeypair("too-short", "testnet", 0)).toThrow(/at least 32/);
    expect(() => channelKeypair(seed, "testnet", -1)).toThrow(/channel index/);
    expect(() => channelKeypair(seed, "testnet", 1.5)).toThrow(/channel index/);
  });
});

describe("fundingNeeded", () => {
  it("creates a missing account, tops up an underfunded one, and leaves the rest", () => {
    expect(fundingNeeded(null)).toBe("create");
    expect(fundingNeeded(0)).toBe("top_up");
    expect(fundingNeeded(TESTNET_REFILL_BELOW_XLM - 0.5)).toBe("top_up");
    expect(fundingNeeded(TESTNET_REFILL_BELOW_XLM)).toBeNull();
    expect(fundingNeeded(10_000)).toBeNull();
  });
});

/** Testnet and relay_channels, in memory: balances by public key, rows by idx (the primary key). */
function fakes(balances: Record<string, number> = {}, failing = new Set<string>()) {
  const rows = new Map<number, ChannelRow>();
  const calls = { create: [] as string[], topUp: [] as string[] };
  const chain = {
    balanceXlm: async (pk: string) => balances[pk] ?? null,
    async create(pk: string) {
      if (failing.has(pk)) throw new Error("Friendbot refused");
      calls.create.push(pk);
      balances[pk] = 10_000;
    },
    async topUp(pk: string) {
      if (failing.has(pk)) throw new Error("Friendbot refused");
      calls.topUp.push(pk);
      balances[pk] += 10_000;
    },
  };
  const db = {
    rows: async () => [...rows.values()].map((row) => ({ ...row })),
    async insert(fresh: ChannelRow[]) {
      for (const row of fresh) {
        if (rows.has(row.idx) || [...rows.values()].some((r) => r.public_key === row.public_key)) {
          throw new Error(`duplicate key for channel ${row.idx}`);
        }
        rows.set(row.idx, { ...row });
      }
    },
    async replaceKey(row: ChannelRow) {
      rows.set(row.idx, { ...row });
    },
    async remove(row: ChannelRow) {
      rows.delete(row.idx);
    },
  };
  return { chain, db, rows, balances, calls };
}

const key = (idx: number) => channelKeypair(seed, "testnet", idx).publicKey();

describe("seedRelayChannels", () => {
  it("creates, funds and records every channel on a first run", async () => {
    const f = fakes();
    const summary = await seedRelayChannels({ seed, network: "testnet", count: 40, chain: f.chain, db: f.db });
    expect(summary).toMatchObject({ created: 40, toppedUp: 0, inserted: 40, rekeyed: 0, skipped: [] });
    expect(f.rows.size).toBe(40);
    expect(f.rows.get(39)).toEqual({ idx: 39, network: "testnet", public_key: key(39) });
  });

  it("can run again: no duplicate rows, and only underfunded accounts are topped up", async () => {
    const f = fakes();
    await seedRelayChannels({ seed, network: "testnet", count: 40, chain: f.chain, db: f.db });
    f.balances[key(5)] = 12.5;
    f.calls.create.length = 0;

    const again = await seedRelayChannels({ seed, network: "testnet", count: 40, chain: f.chain, db: f.db });
    expect(again).toMatchObject({ created: 0, toppedUp: 1, inserted: 0, rekeyed: 0, skipped: [] });
    expect(f.calls.create).toEqual([]);
    expect(f.calls.topUp).toEqual([key(5)]);
    expect(f.rows.size).toBe(40);
  });

  it("gives a channel whose funding failed no row, so it is never leased, until a later run funds it", async () => {
    const failing = new Set([key(2)]);
    const f = fakes({}, failing);
    const first = await seedRelayChannels({ seed, network: "testnet", count: 4, chain: f.chain, db: f.db });
    expect(first.inserted).toBe(3);
    expect(first.skipped).toEqual([expect.stringMatching(/^2: funding failed \(Friendbot refused\)/)]);
    expect(f.rows.has(2)).toBe(false);

    failing.clear();
    const second = await seedRelayChannels({ seed, network: "testnet", count: 4, chain: f.chain, db: f.db });
    expect(second).toMatchObject({ created: 1, inserted: 1 });
    expect(f.rows.get(2)?.public_key).toBe(key(2));
  });

  it("points a row at the new key after RELAY_CHANNEL_SEED changes", async () => {
    const f = fakes();
    await seedRelayChannels({ seed: `${seed}-old`, network: "testnet", count: 2, chain: f.chain, db: f.db });
    const summary = await seedRelayChannels({ seed, network: "testnet", count: 2, chain: f.chain, db: f.db });
    expect(summary).toMatchObject({ created: 2, inserted: 0, rekeyed: 2 });
    expect([...f.rows.values()].map((r) => r.public_key)).toEqual([key(0), key(1)]);
  });

  it("removes a row it couldn't re-key, so no row is left on the old key", async () => {
    const f = fakes();
    await seedRelayChannels({ seed: `${seed}-old`, network: "testnet", count: 3, chain: f.chain, db: f.db });
    const failing = new Set([key(1)]);
    const g = fakes(f.balances, failing);
    for (const row of f.rows.values()) g.rows.set(row.idx, row);

    const summary = await seedRelayChannels({ seed, network: "testnet", count: 3, chain: g.chain, db: g.db });
    expect(summary).toMatchObject({ rekeyed: 2, removed: 1 });
    expect(summary.skipped).toEqual([expect.stringMatching(/^1: funding failed .*old key, was removed/)]);
    expect([...g.rows.values()].map((r) => [r.idx, r.public_key])).toEqual([
      [0, key(0)],
      [2, key(2)],
    ]);

    failing.clear();
    const again = await seedRelayChannels({ seed, network: "testnet", count: 3, chain: g.chain, db: g.db });
    expect(again).toMatchObject({ created: 1, inserted: 1, removed: 0 });
    expect(g.rows.get(1)?.public_key).toBe(key(1));
  });

  it("keeps a row whose top-up failed when its key is current", async () => {
    const f = fakes();
    await seedRelayChannels({ seed, network: "testnet", count: 2, chain: f.chain, db: f.db });
    f.balances[key(1)] = 5;
    const g = fakes(f.balances, new Set([key(1)]));
    for (const row of f.rows.values()) g.rows.set(row.idx, row);
    const summary = await seedRelayChannels({ seed, network: "testnet", count: 2, chain: g.chain, db: g.db });
    expect(summary).toMatchObject({ removed: 0 });
    expect(summary.skipped).toEqual([expect.stringMatching(/^1: funding failed .*its row stays/)]);
    expect(g.rows.get(1)?.public_key).toBe(key(1));
  });

  it("removes rows past count on an old key, and keeps those on the current one", async () => {
    const f = fakes();
    await seedRelayChannels({ seed: `${seed}-old`, network: "testnet", count: 4, chain: f.chain, db: f.db });
    f.rows.set(3, { idx: 3, network: "testnet", public_key: key(3) });
    const summary = await seedRelayChannels({ seed, network: "testnet", count: 2, chain: f.chain, db: f.db });
    expect(summary).toMatchObject({ rekeyed: 2, removed: 1 });
    expect([...f.rows.keys()].sort()).toEqual([0, 1, 3]);
    expect(f.rows.get(3)?.public_key).toBe(key(3));
  });

  it("with dryRun, removes nothing either", async () => {
    const f = fakes();
    await seedRelayChannels({ seed: `${seed}-old`, network: "testnet", count: 3, chain: f.chain, db: f.db });
    const summary = await seedRelayChannels({ seed, network: "testnet", count: 1, chain: f.chain, db: f.db, dryRun: true });
    expect(summary).toMatchObject({ rekeyed: 1, removed: 2 });
    expect(f.rows.size).toBe(3);
    expect(f.rows.get(0)?.public_key).toBe(channelKeypair(`${seed}-old`, "testnet", 0).publicKey());
  });

  it("leaves a row seeded for the other network alone", async () => {
    const f = fakes();
    const other = Keypair.random().publicKey();
    await f.db.insert([{ idx: 0, network: "mainnet", public_key: other }]);
    const summary = await seedRelayChannels({ seed, network: "testnet", count: 2, chain: f.chain, db: f.db });
    expect(summary.skipped).toEqual(["0: the row is for mainnet; left as it is"]);
    expect(f.rows.get(0)?.public_key).toBe(other);
    expect(f.calls.create).toEqual([key(1)]);
  });

  it("with dryRun, reports what it would do and changes nothing", async () => {
    const f = fakes();
    const summary = await seedRelayChannels({ seed, network: "testnet", count: 3, chain: f.chain, db: f.db, dryRun: true });
    expect(summary).toMatchObject({ created: 3, inserted: 3 });
    expect(f.calls.create).toEqual([]);
    expect(f.rows.size).toBe(0);
  });

  it("refuses mainnet: Friendbot only exists on testnet", async () => {
    const f = fakes();
    await expect(seedRelayChannels({ seed, network: "mainnet", count: 1, chain: f.chain, db: f.db })).rejects.toThrow(/testnet only/);
  });
});
