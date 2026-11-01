/**
 * Leases channel accounts for user-paid writes (server-only, WP-4.1, DOQ-3).
 *
 * Every paid write used to have Doqtri's relayer as its transaction source,
 * and Stellar takes one pending transaction per source account, so about one
 * write landed per ledger and the rest came back 502. Each write instead
 * leases one channel account from relay_channels
 * (backend/migrations/20261101100000_relay_channels.sql), uses it as the
 * source, and gives it back with the sequence number its next transaction
 * carries. The relayer still signs its own forward() approval and still
 * receives the fee.
 *
 * When every channel is busy, a lease is asked for again every 500 ms for
 * up to 20 s, then the request is refused with a 503 and Retry-After. A
 * lease lasts 90 s, longer than the 60 s time bound on every paid write, so
 * a lease that runs out (a server that died mid-write) can't hand an account
 * to a second write while the first one's transaction could still land.
 * That holds while the transaction is built within LEASE_BUILD_BUDGET_SECONDS
 * of the lease, counting clock skew: its time bound comes from this server's
 * clock at build time, the lease's end from the database's.
 *
 * Releasing (for DOQ-4). The holder builds with the larger of the RPC's
 * sequence number and the lease's nextSeq, and releases with the sequence
 * number the channel's next transaction carries. The stored value is
 * replaced, not raised, so pass:
 * - used + 1 once the transaction was accepted for submission (landed, or
 *   failed on-chain: both consume the sequence number, and so may a pending
 *   one that later lands);
 * - null when it was refused before it could consume anything (simulation
 *   or a submit error such as TRY_AGAIN_LATER): the stored floor stands;
 * - the RPC's account sequence + 1, read after the failure, on txBadSeq: the
 *   stored floor was wrong, and this is how it comes down again.
 *
 * Keys come from RELAY_CHANNEL_SEED and the channel's index
 * (channel-accounts.mjs); the database holds public keys only.
 * direct-submit.ts leases from here when RELAY_POOL is on (DOQ-4); with it
 * off, paid writes still go out from the relayer alone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Keypair } from "@stellar/stellar-sdk";
import { channelKeypair, MIN_SEED_LENGTH } from "@/lib/stellar/channel-accounts.mjs";
import { RelayRejection } from "@/lib/stellar/relay-validation";
import type { StellarNetwork } from "@/lib/stellar/smart-wallet-config";

/** How long a lease holds its channel. */
export const LEASE_TTL_SECONDS = 90;
/**
 * The time bound on every paid write (`setTimeout(60)` in direct-submit.ts).
 * The lease must outlive it; channel-pool.test.ts checks the two against the
 * source, and lease_relay_channel() refuses a TTL of 60 s or less.
 */
export const PAID_WRITE_TIMEOUT_SECONDS = 60;
/**
 * How long after leasing a transaction may still be built: the lease must end
 * after the transaction's time bound, which starts at build time.
 */
export const LEASE_BUILD_BUDGET_SECONDS = LEASE_TTL_SECONDS - PAID_WRITE_TIMEOUT_SECONDS;
/** How long a request waits for a free channel before it is refused. */
export const LEASE_WAIT_MS = 20_000;
/** How often a waiting request asks again. */
export const LEASE_POLL_MS = 500;
/** What a refused request is told to wait: about one ledger, by when leases have turned over. */
export const POOL_BUSY_RETRY_AFTER_SECONDS = 5;

/** A row as lease_relay_channel() returns it; next_seq is text (it runs past 2^53). */
export type LeasedRow = { idx: number; lease_id: string; next_seq: string | null; public_key: string };

/** The database side of the pool; Supabase in production, an in-memory store in tests. */
export type ChannelPoolStore = {
  /** Claims a free channel on `network` for `ttlSeconds`, or null when all are leased. */
  lease(network: StellarNetwork, ttlSeconds: number): Promise<LeasedRow | null>;
  /** Gives a lease back with the channel's next sequence number (null keeps the stored one); false when the lease had already passed on. */
  release(idx: number, leaseId: string, nextSeq: bigint | null): Promise<boolean>;
};

export type ChannelLease = {
  idx: number;
  leaseId: string;
  publicKey: string;
  /** Signs the transaction envelope as its source. */
  keypair: Keypair;
  /**
   * The sequence number the channel's next transaction carries, as the last
   * holder saw it, or null when it has none yet. A floor under the RPC's
   * read, which can lag a ledger behind.
   */
  nextSeq: bigint | null;
};

export type LeaseOptions = {
  network: StellarNetwork;
  /** RELAY_CHANNEL_SEED (relayChannelSeed()). */
  seed: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MISCONFIGURED = "Paid writes are misconfigured on this server";

/**
 * RELAY_POOL=on sends paid writes from leased channels. Anything else, unset
 * included, keeps the relayer as the only source, so the pool can be switched
 * off from the dashboard without a deploy of different code.
 */
export function relayPoolEnabled(): boolean {
  return process.env.RELAY_POOL?.trim().replace(/^["']|["']$/g, "").toLowerCase() === "on";
}

/** RELAY_CHANNEL_SEED, or a 503 when it is missing or too short to guard the channels' keys. */
export function relayChannelSeed(): string {
  const seed = process.env.RELAY_CHANNEL_SEED?.trim();
  if (!seed) throw new RelayRejection("Paid writes are not configured", 503);
  return checkedSeed(seed);
}

/** The seed as given, or a 503 when it is too short to guard the channels' keys. */
function checkedSeed(seed: string | undefined): string {
  if (!seed || seed.length < MIN_SEED_LENGTH) {
    console.error(`[channel-pool] RELAY_CHANNEL_SEED is missing or shorter than ${MIN_SEED_LENGTH} characters`);
    throw new RelayRejection(MISCONFIGURED, 503);
  }
  return seed;
}

/**
 * Leases a channel, waiting for one while the pool is full. Throws a 503
 * RelayRejection with Retry-After once `waitMs` has passed without one.
 *
 * The seed is checked before anything is leased, so a bad one never strands
 * a lease. A channel whose stored key the seed doesn't derive is skipped and
 * its lease kept, not released: it lapses in 90 s, and until then the next
 * lease can't hand the same bad row straight back.
 */
export async function leaseChannel(store: ChannelPoolStore, options: LeaseOptions): Promise<ChannelLease> {
  const { now = Date.now, sleep = defaultSleep, waitMs = LEASE_WAIT_MS, pollMs = LEASE_POLL_MS } = options;
  const seed = checkedSeed(options.seed);
  const deadline = now() + waitMs;
  for (;;) {
    const row = await store.lease(options.network, LEASE_TTL_SECONDS);
    const lease = row && toLease(row, seed, options.network);
    if (lease) return lease;
    if (row) continue;
    if (now() + pollMs > deadline) {
      console.warn(`[channel-pool] no free ${options.network} channel after ${waitMs} ms`);
      throw new RelayRejection(
        "Doqtri is busy sending other writes. Try again in a few seconds.",
        503,
        POOL_BUSY_RETRY_AFTER_SECONDS,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * The lease with its keypair, or null when the row's public key isn't the one
 * the seed derives (the seed changed and the pool wasn't seeded again): a
 * transaction from it would fail on-chain with a bad signature.
 */
function toLease(row: LeasedRow, seed: string, network: StellarNetwork): ChannelLease | null {
  const keypair = channelKeypair(seed, network, row.idx);
  if (keypair.publicKey() !== row.public_key) {
    console.error(
      `[channel-pool] channel ${row.idx} is ${row.public_key} in the database, but RELAY_CHANNEL_SEED derives ${keypair.publicKey()}; skipping it until its lease lapses. Run scripts/seed-relay-channels.mjs`,
    );
    return null;
  }
  return {
    idx: row.idx,
    leaseId: row.lease_id,
    publicKey: row.public_key,
    keypair,
    nextSeq: row.next_seq === null ? null : BigInt(row.next_seq),
  };
}

/**
 * Gives a lease back with the sequence number the channel's next transaction
 * carries, which replaces the stored one; null keeps it (see the header for
 * which to pass). Never throws: by now
 * the write has landed or failed, and a lease that isn't released runs out
 * by itself. False when it wasn't released.
 */
export async function releaseChannel(
  store: ChannelPoolStore,
  lease: Pick<ChannelLease, "idx" | "leaseId">,
  nextSeq: bigint | null,
): Promise<boolean> {
  try {
    const released = await store.release(lease.idx, lease.leaseId, nextSeq);
    if (!released) console.warn(`[channel-pool] channel ${lease.idx}'s lease had passed on before it was released`);
    return released;
  } catch (error) {
    console.error(`[channel-pool] releasing channel ${lease.idx} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** The pool in doqtri's database, through the service role. */
export function supabaseChannelPoolStore(admin: SupabaseClient): ChannelPoolStore {
  return {
    async lease(network, ttlSeconds) {
      const { data, error } = await admin.rpc("lease_relay_channel", { p_network: network, p_ttl: `${ttlSeconds} seconds` });
      if (error) {
        console.error(`[channel-pool] lease failed: ${error.message}`);
        throw new RelayRejection("On-chain actions are temporarily unavailable.", 503);
      }
      return ((data as LeasedRow[] | null) ?? [])[0] ?? null;
    },
    async release(idx, leaseId, nextSeq) {
      const { data, error } = await admin.rpc("release_relay_channel", {
        p_idx: idx,
        p_lease_id: leaseId,
        // As text: a JSON number would round a sequence number past 2^53.
        p_next_seq: nextSeq === null ? null : nextSeq.toString(),
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
  };
}
