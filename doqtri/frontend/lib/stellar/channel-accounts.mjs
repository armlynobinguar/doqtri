/**
 * The relay pool's channel accounts (WP-4.1, DOQ-3): how each one's keypair
 * is derived, and how the pool is seeded. Shared by the server
 * (lib/stellar/channel-pool.ts) and scripts/seed-relay-channels.mjs, which
 * is why this one file is plain JavaScript: Node runs the script without a
 * build step, and both sides must derive exactly the same keys.
 *
 * A channel's secret is never stored. It is HMAC-SHA256(RELAY_CHANNEL_SEED,
 * "doqtri-relay-channel:<network>:<idx>") used as a raw ed25519 seed, so the
 * seed in the server's env plus a row's idx gives back the keypair, and the
 * relay_channels table holds public keys only. The network is part of the
 * message, so a seed shared by mistake between testnet and mainnet still
 * gives different accounts on each.
 */
import { createHmac } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

/** RELAY_CHANNEL_SEED is refused below this length: it guards every channel's key. */
export const MIN_SEED_LENGTH = 32;

/** On testnet, an account below this balance is topped up from Friendbot by the seed script. */
export const TESTNET_REFILL_BELOW_XLM = 1_000;

/**
 * The keypair of channel `idx` on `network`. Deterministic: the same seed,
 * network and index always give the same account.
 *
 * @param {string} seed RELAY_CHANNEL_SEED
 * @param {"testnet" | "mainnet"} network
 * @param {number} idx the relay_channels row's idx
 * @returns {Keypair}
 */
export function channelKeypair(seed, network, idx) {
  if (!seed || seed.length < MIN_SEED_LENGTH) {
    throw new Error(`RELAY_CHANNEL_SEED must be at least ${MIN_SEED_LENGTH} characters`);
  }
  if (!Number.isInteger(idx) || idx < 0) throw new Error(`Not a channel index: ${idx}`);
  const raw = createHmac("sha256", seed).update(`doqtri-relay-channel:${network}:${idx}`).digest();
  return Keypair.fromRawEd25519Seed(raw);
}

/**
 * What the seed script does about one account, from its native balance in
 * XLM (null when the account doesn't exist yet): create it, top it up, or
 * leave it.
 *
 * @param {number | null} balanceXlm
 * @returns {"create" | "top_up" | null}
 */
export function fundingNeeded(balanceXlm) {
  if (balanceXlm === null) return "create";
  return balanceXlm < TESTNET_REFILL_BELOW_XLM ? "top_up" : null;
}

/**
 * @typedef {{ idx: number, network: string, public_key: string }} ChannelRow
 *
 * @typedef {object} SeedChain
 * @property {(publicKey: string) => Promise<number | null>} balanceXlm native balance, null when the account doesn't exist
 * @property {(publicKey: string) => Promise<void>} create creates the account with Friendbot's starting balance
 * @property {(publicKey: string) => Promise<void>} topUp adds Friendbot's starting balance to an existing account
 *
 * @typedef {object} SeedDb
 * @property {() => Promise<ChannelRow[]>} rows every relay_channels row
 * @property {(rows: ChannelRow[]) => Promise<void>} insert adds new rows
 * @property {(row: ChannelRow) => Promise<void>} replaceKey points an existing idx at a new public key, forgetting its next_seq
 *
 * @typedef {object} SeedSummary
 * @property {number} created accounts created on-chain
 * @property {number} toppedUp accounts topped up
 * @property {number} inserted rows added
 * @property {number} rekeyed rows whose public key changed (a new RELAY_CHANNEL_SEED)
 * @property {string[]} skipped one line per channel left out, and why
 */

/**
 * Funds channels 0..count-1 where they need it, then records the funded ones
 * in relay_channels. Safe to run again: an account with enough XLM is left
 * alone, a row already there is not written twice, and a channel whose
 * funding failed gets no row (so it is never leased) until a later run funds
 * it. Rows past `count` are left as they are. With `dryRun`, it reads and
 * reports but neither funds nor writes.
 *
 * @param {{ seed: string, network: "testnet" | "mainnet", count: number, chain: SeedChain, db: SeedDb, dryRun?: boolean, log?: (line: string) => void }} options
 * @returns {Promise<SeedSummary>}
 */
export async function seedRelayChannels({ seed, network, count, chain, db, dryRun = false, log = () => {} }) {
  if (network !== "testnet") throw new Error("Channel accounts are funded from Friendbot, which is testnet only.");
  /** @type {SeedSummary} */
  const summary = { created: 0, toppedUp: 0, inserted: 0, rekeyed: 0, skipped: [] };
  const existing = new Map((await db.rows()).map((row) => [row.idx, row]));

  /** @type {ChannelRow[]} */
  const fresh = [];
  for (let idx = 0; idx < count; idx++) {
    const publicKey = channelKeypair(seed, network, idx).publicKey();
    const row = existing.get(idx);
    if (row && row.network !== network) {
      summary.skipped.push(`${idx}: the row is for ${row.network}; left as it is`);
      continue;
    }

    try {
      const need = fundingNeeded(await chain.balanceXlm(publicKey));
      if (need === "create") {
        if (!dryRun) await chain.create(publicKey);
        summary.created++;
        log(`${idx} ${publicKey}: created`);
      } else if (need === "top_up") {
        if (!dryRun) await chain.topUp(publicKey);
        summary.toppedUp++;
        log(`${idx} ${publicKey}: topped up`);
      }
    } catch (error) {
      summary.skipped.push(`${idx}: funding failed (${error instanceof Error ? error.message : String(error)}); no row until it is funded`);
      continue;
    }

    if (!row) {
      fresh.push({ idx, network, public_key: publicKey });
    } else if (row.public_key !== publicKey) {
      if (!dryRun) await db.replaceKey({ idx, network, public_key: publicKey });
      summary.rekeyed++;
      log(`${idx}: public key changed from ${row.public_key} to ${publicKey}`);
    }
  }

  if (fresh.length && !dryRun) await db.insert(fresh);
  summary.inserted = fresh.length;
  return summary;
}
