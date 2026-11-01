import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { channelKeypair } from "@/lib/stellar/channel-accounts.mjs";
import {
  LEASE_BUILD_BUDGET_SECONDS,
  LEASE_POLL_MS,
  LEASE_TTL_SECONDS,
  LEASE_WAIT_MS,
  leaseChannel,
  PAID_WRITE_TIMEOUT_SECONDS,
  POOL_BUSY_RETRY_AFTER_SECONDS,
  relayChannelSeed,
  releaseChannel,
  supabaseChannelPoolStore,
  type ChannelPoolStore,
  type LeasedRow,
} from "@/lib/stellar/channel-pool";

const seed = "a-test-relay-channel-seed-of-40-chars-xx";
const leaseId = "5f1c0000-0000-4000-8000-000000000001";

function rowFor(idx: number, over: Partial<LeasedRow> = {}): LeasedRow {
  return { idx, lease_id: leaseId, next_seq: null, public_key: channelKeypair(seed, "testnet", idx).publicKey(), ...over };
}

/** Hands out `rows` one lease at a time, then null (a full pool); records every call. */
function memoryPool(rows: (LeasedRow | null)[] = []) {
  const released: { idx: number; leaseId: string; nextSeq: bigint | null }[] = [];
  const store: ChannelPoolStore & { leases: number; ttls: number[]; released: typeof released } = {
    leases: 0,
    ttls: [],
    released,
    async lease(_network, ttlSeconds) {
      store.leases++;
      store.ttls.push(ttlSeconds);
      return rows.shift() ?? null;
    },
    async release(idx, id, nextSeq) {
      released.push({ idx, leaseId: id, nextSeq });
      return true;
    },
  };
  return store;
}

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  const clock = { t: 0, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms) };
  return clock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the lease TTL", () => {
  it("leaves a 30 s budget between leasing and building the transaction", () => {
    expect(LEASE_BUILD_BUDGET_SECONDS).toBe(LEASE_TTL_SECONDS - PAID_WRITE_TIMEOUT_SECONDS);
    expect(LEASE_BUILD_BUDGET_SECONDS).toBe(30);
  });

  const directSubmit = readFileSync(fileURLToPath(new URL("./direct-submit.ts", import.meta.url)), "utf8");
  const migration = readFileSync(
    fileURLToPath(new URL("../../../backend/migrations/20261101100000_relay_channels.sql", import.meta.url)),
    "utf8",
  );

  it("outlives the time bound on every paid write", () => {
    const bounds = [...directSubmit.matchAll(/\.setTimeout\((\d+)\)/g)].map((m) => Number(m[1]));
    expect(bounds.length).toBeGreaterThan(0);
    for (const bound of bounds) expect(bound).toBeLessThanOrEqual(PAID_WRITE_TIMEOUT_SECONDS);
    expect(LEASE_TTL_SECONDS).toBeGreaterThan(PAID_WRITE_TIMEOUT_SECONDS);
  });

  it("is the database's default, and the database refuses one that doesn't outlive the write", () => {
    expect(migration).toContain(`p_ttl interval default interval '${LEASE_TTL_SECONDS} seconds'`);
    expect(migration).toContain(`p_ttl <= interval '${PAID_WRITE_TIMEOUT_SECONDS} seconds'`);
  });

  it("is what a lease asks for", async () => {
    const store = memoryPool([rowFor(0)]);
    await leaseChannel(store, { network: "testnet", seed });
    expect(store.ttls).toEqual([LEASE_TTL_SECONDS]);
  });
});

describe("leaseChannel", () => {
  it("returns the leased channel with the keypair the seed derives for it", async () => {
    const store = memoryPool([rowFor(7, { next_seq: "9007199254740993" })]);
    const lease = await leaseChannel(store, { network: "testnet", seed });
    expect(lease.idx).toBe(7);
    expect(lease.leaseId).toBe(leaseId);
    expect(lease.keypair.publicKey()).toBe(channelKeypair(seed, "testnet", 7).publicKey());
    expect(lease.publicKey).toBe(lease.keypair.publicKey());
    expect(lease.nextSeq).toBe(BigInt("9007199254740993"));
  });

  it("has no next sequence number for a channel never released with one", async () => {
    const lease = await leaseChannel(memoryPool([rowFor(0)]), { network: "testnet", seed });
    expect(lease.nextSeq).toBeNull();
  });

  it("asks again every 500 ms while the pool is full, and takes the first channel freed", async () => {
    const clock = fakeClock();
    const store = memoryPool([null, null, null, rowFor(2)]);
    const lease = await leaseChannel(store, { network: "testnet", seed, now: clock.now, sleep: clock.sleep });
    expect(lease.idx).toBe(2);
    expect(store.leases).toBe(4);
    expect(clock.t).toBe(3 * LEASE_POLL_MS);
  });

  it("gives up after 20 s with a 503 that carries Retry-After", async () => {
    const clock = fakeClock();
    const store = memoryPool();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(leaseChannel(store, { network: "testnet", seed, now: clock.now, sleep: clock.sleep })).rejects.toMatchObject({
      name: "RelayRejection",
      status: 503,
      retryAfterSeconds: POOL_BUSY_RETRY_AFTER_SECONDS,
    });
    expect(clock.t).toBe(LEASE_WAIT_MS);
    // At 0, 0.5 s, …, 20 s: the last try is at the deadline, not past it.
    expect(store.leases).toBe(LEASE_WAIT_MS / LEASE_POLL_MS + 1);
  });

  it("gives up after 20 s on the real timer too", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryPool();
    const outcome = expect(leaseChannel(store, { network: "testnet", seed })).rejects.toMatchObject({ status: 503, retryAfterSeconds: 5 });
    await vi.advanceTimersByTimeAsync(LEASE_WAIT_MS - LEASE_POLL_MS);
    expect(store.leases).toBe(LEASE_WAIT_MS / LEASE_POLL_MS);
    await vi.advanceTimersByTimeAsync(LEASE_POLL_MS);
    await outcome;
  });

  it("skips a channel whose stored key the seed doesn't derive, keeping its lease, and takes the next one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = fakeClock();
    const stale = rowFor(3, { public_key: channelKeypair(`${seed}-old`, "testnet", 3).publicKey() });
    const store = memoryPool([stale, rowFor(4)]);
    const lease = await leaseChannel(store, { network: "testnet", seed, now: clock.now, sleep: clock.sleep });
    expect(lease.idx).toBe(4);
    expect(lease.keypair.publicKey()).toBe(channelKeypair(seed, "testnet", 4).publicKey());
    // Not released: released, it would sort first and come straight back.
    // Kept, it lapses in 90 s, out of the way.
    expect(store.released).toEqual([]);
    expect(store.leases).toBe(2);
    expect(clock.t).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("channel 3 is"));
  });

  it("waits as usual when every free channel has a stale key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const clock = fakeClock();
    const stale = (idx: number) => rowFor(idx, { public_key: channelKeypair(`${seed}-old`, "testnet", idx).publicKey() });
    const store = memoryPool([stale(0), stale(1)]);
    await expect(leaseChannel(store, { network: "testnet", seed, now: clock.now, sleep: clock.sleep })).rejects.toMatchObject({
      status: 503,
      retryAfterSeconds: POOL_BUSY_RETRY_AFTER_SECONDS,
    });
    expect(store.released).toEqual([]);
  });

  it("checks the seed before leasing, so a bad one never strands a lease", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of ["", "too-short"]) {
      const store = memoryPool([rowFor(0)]);
      await expect(leaseChannel(store, { network: "testnet", seed: bad })).rejects.toMatchObject({
        name: "RelayRejection",
        status: 503,
        message: "Paid writes are misconfigured on this server",
      });
      expect(store.leases).toBe(0);
    }
  });
});

describe("releaseChannel", () => {
  it("gives the lease back with the next sequence number", async () => {
    const store = memoryPool();
    expect(await releaseChannel(store, { idx: 1, leaseId }, BigInt(42))).toBe(true);
    expect(store.released).toEqual([{ idx: 1, leaseId, nextSeq: BigInt(42) }]);
  });

  it("never throws: a lease it can't release runs out by itself", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = { ...memoryPool(), release: async () => Promise.reject(new Error("network down")) };
    expect(await releaseChannel(store, { idx: 1, leaseId }, BigInt(42))).toBe(false);
  });
});

describe("relayChannelSeed", () => {
  it("reads RELAY_CHANNEL_SEED", () => {
    vi.stubEnv("RELAY_CHANNEL_SEED", ` ${seed}\n`);
    expect(relayChannelSeed()).toBe(seed);
  });

  it("is a 503 when the seed is missing or too short", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("RELAY_CHANNEL_SEED", "");
    expect(() => relayChannelSeed()).toThrow(expect.objectContaining({ status: 503 }));
    vi.stubEnv("RELAY_CHANNEL_SEED", "short");
    expect(() => relayChannelSeed()).toThrow(expect.objectContaining({ status: 503 }));
  });
});

describe("supabaseChannelPoolStore", () => {
  function admin(result: { data: unknown; error: { message: string } | null }) {
    const rpc = vi.fn().mockResolvedValue(result);
    return { client: { rpc } as unknown as SupabaseClient, rpc };
  }

  it("leases through lease_relay_channel with the TTL as an interval", async () => {
    const { client, rpc } = admin({ data: [rowFor(0)], error: null });
    expect(await supabaseChannelPoolStore(client).lease("testnet", 90)).toEqual(rowFor(0));
    expect(rpc).toHaveBeenCalledWith("lease_relay_channel", { p_network: "testnet", p_ttl: "90 seconds" });
  });

  it("is null when every channel is leased", async () => {
    const { client } = admin({ data: [], error: null });
    expect(await supabaseChannelPoolStore(client).lease("testnet", 90)).toBeNull();
  });

  it("turns a database error into a 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = admin({ data: null, error: { message: "boom" } });
    await expect(supabaseChannelPoolStore(client).lease("testnet", 90)).rejects.toMatchObject({ status: 503 });
  });

  it("sends the next sequence number as text, so it isn't rounded", async () => {
    const { client, rpc } = admin({ data: true, error: null });
    expect(await supabaseChannelPoolStore(client).release(2, leaseId, BigInt("9007199254740993"))).toBe(true);
    expect(rpc).toHaveBeenCalledWith("release_relay_channel", { p_idx: 2, p_lease_id: leaseId, p_next_seq: "9007199254740993" });
  });

  it("reports a release that matched nothing", async () => {
    const { client } = admin({ data: false, error: null });
    expect(await supabaseChannelPoolStore(client).release(2, leaseId, null)).toBe(false);
  });
});
