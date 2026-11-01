/**
 * Creates, funds and records the relay's channel accounts (WP-4.1, DOQ-3).
 *
 *   RELAY_CHANNEL_SEED=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/seed-relay-channels.mjs [--count=40] [--dry-run]
 *
 * - Channel i's keypair is derived from RELAY_CHANNEL_SEED and i
 *   (lib/stellar/channel-accounts.mjs), exactly as the server derives it,
 *   so run this with the seed the deployment uses. Only public keys reach
 *   the database.
 * - An account that doesn't exist is created by Friendbot. One below
 *   1,000 XLM is topped up: Friendbot funds a throwaway account, which is
 *   then merged into the channel (Friendbot pays new accounts only).
 * - A funded channel gets its relay_channels row (idx, network, public_key).
 *   One whose funding failed gets none, so it is never leased; run again.
 * - Safe to run again: funded accounts are left alone, existing rows are
 *   not written twice, and rows past --count are kept. After a seed change,
 *   each row is pointed at its new key and its next_seq and lease are
 *   forgotten; a row whose new account couldn't be funded, and a row past
 *   --count, are deleted instead, so no row is left on an old key.
 * - --dry-run reads Horizon and the table and reports; it funds and writes
 *   nothing.
 *
 * Testnet only (Friendbot). The table is service-role only, hence the key.
 */
import { createClient } from "@supabase/supabase-js";
import { Horizon, Keypair, Networks, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { MIN_SEED_LENGTH, seedRelayChannels } from "../lib/stellar/channel-accounts.mjs";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL?.trim() || "https://horizon-testnet.stellar.org";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const count = Number(args.find((a) => a.startsWith("--count="))?.split("=")[1] ?? 40);
const seed = process.env.RELAY_CHANNEL_SEED?.trim() ?? "";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const passphrase = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE?.trim().replace(/^["']|["']$/g, "");

function usage(problem) {
  console.error(problem);
  console.error("usage: RELAY_CHANNEL_SEED=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-relay-channels.mjs [--count=40] [--dry-run]");
  process.exit(1);
}

if (seed.length < MIN_SEED_LENGTH) usage(`RELAY_CHANNEL_SEED must be set, at least ${MIN_SEED_LENGTH} characters.`);
if (!supabaseUrl || !serviceRoleKey) usage("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
if (!Number.isInteger(count) || count < 1 || count > 1000) usage("--count must be a whole number from 1 to 1000.");
if (passphrase && passphrase !== Networks.TESTNET) usage("Channel accounts are funded from Friendbot, so this runs on testnet only.");

const horizon = new Horizon.Server(HORIZON_URL);
const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

async function friendbot(publicKey) {
  const res = await fetch(`${FRIENDBOT}/?addr=${publicKey}`);
  if (!res.ok) throw new Error(`Friendbot answered ${res.status}`);
}

/** @type {import("../lib/stellar/channel-accounts.mjs").SeedChain} */
const chain = {
  async balanceXlm(publicKey) {
    try {
      const account = await horizon.loadAccount(publicKey);
      return Number(account.balances.find((b) => b.asset_type === "native")?.balance ?? 0);
    } catch (error) {
      if (error?.response?.status === 404) return null;
      throw error;
    }
  },
  create: friendbot,
  async topUp(publicKey) {
    const temp = Keypair.random();
    await friendbot(temp.publicKey());
    const tx = new TransactionBuilder(await horizon.loadAccount(temp.publicKey()), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.accountMerge({ destination: publicKey }))
      .setTimeout(60)
      .build();
    tx.sign(temp);
    await horizon.submitTransaction(tx);
  },
};

/** @type {import("../lib/stellar/channel-accounts.mjs").SeedDb} */
const table = {
  async rows() {
    const { data, error } = await db.from("relay_channels").select("idx, network, public_key");
    if (error) throw new Error(`reading relay_channels failed: ${error.message}`);
    return data;
  },
  async insert(rows) {
    const { error } = await db.from("relay_channels").insert(rows);
    if (error) throw new Error(`inserting channels failed: ${error.message}`);
  },
  async replaceKey(row) {
    const { error } = await db
      .from("relay_channels")
      // A holder still on the old key then can't release onto the new account.
      .update({ public_key: row.public_key, next_seq: null, lease_id: null, leased_until: null })
      .eq("idx", row.idx)
      .eq("network", row.network);
    if (error) throw new Error(`re-keying channel ${row.idx} failed: ${error.message}`);
  },
  async remove(row) {
    const { error } = await db.from("relay_channels").delete().eq("idx", row.idx).eq("network", row.network);
    if (error) throw new Error(`removing channel ${row.idx} failed: ${error.message}`);
  },
};

const summary = await seedRelayChannels({ seed, network: "testnet", count, chain, db: table, dryRun, log: console.log });
console.log(`${dryRun ? "[dry run] would have: " : ""}created ${summary.created}, topped up ${summary.toppedUp}, inserted ${summary.inserted}, re-keyed ${summary.rekeyed}, removed ${summary.removed}`);
for (const line of summary.skipped) console.warn(`skipped ${line}`);
if (summary.skipped.length) process.exitCode = 1;
