/**
 * Submits forwarded (user-paid) writes as Doqtri's relayer account, straight
 * to Stellar RPC — no Channels (server-only, progress/003).
 *
 * The relayer is the transaction source and pays the network fee; inside the
 * same transaction the FeeForwarder moves `fee_amount` XLM from the user's
 * wallet to the relayer. `fee_amount` is set here, from a simulation that
 * already includes the wallet's passkey signature (verifying it costs extra),
 * and is never above the maximum the user signed.
 *
 * With RELAY_POOL=on (WP-4.1, DOQ-4) the transaction source is instead a
 * channel account leased from channel-pool.ts, which signs the envelope and
 * pays the network fee from its own balance (self-funded: it must already
 * hold XLM, see scripts/seed-relay-channels.mjs). The relayer is no longer
 * the source but still signs its own forward() approval and still receives
 * fee_amount, so the FeeForwarder doesn't change. A single source account
 * takes about one transaction per ledger; a pool of them takes one each.
 * With the flag off the relayer path below runs exactly as before.
 *
 * Either way a write is polled for about 20 s once the network accepts it.
 * One still not found by then may yet land, so it comes back pending rather
 * than failed (DOQ-5): the relay answers 202 and records it, and the
 * chain-jobs run settles it later (pending-writes.ts).
 */
import {
  Account,
  authorizeEntry,
  Horizon,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { HORIZON_URL, IS_MAINNET, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import {
  LEASE_BUILD_BUDGET_SECONDS,
  leaseChannel,
  PAID_WRITE_TIMEOUT_SECONDS,
  relayChannelSeed,
  relayPoolEnabled,
  releaseChannel,
  supabaseChannelPoolStore,
  type ChannelLease,
  type ChannelPoolStore,
} from "@/lib/stellar/channel-pool";
import { paidWriteTimer, type PaidWriteTimer } from "@/lib/stellar/paid-write-timing";
import { RelayRejection } from "@/lib/stellar/relay-validation";
import { DOQTRI_RELAYER, NETWORK } from "@/lib/stellar/smart-wallet-config";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Inclusion fee bid per transaction, in stroops (0.0001 XLM). */
const INCLUSION_FEE = 1_000;
/** On testnet, refill the relayer from Friendbot below this balance. */
const TESTNET_REFILL_BELOW_XLM = 1_000;
/** How long the relayer's own approval stays valid, in ledgers (~10 minutes). */
const RELAYER_AUTH_LEDGERS = 100;

export function relayerKeypair(): Keypair {
  const secret = process.env.DOQTRI_RELAYER_SECRET?.trim();
  if (!secret) throw new RelayRejection("Paid writes are not configured", 503);
  const kp = Keypair.fromSecret(secret);
  // The browser names DOQTRI_RELAYER in the call it signs; a key for any other
  // account cannot authorize it, and the simulation would only say "fails".
  if (kp.publicKey() !== DOQTRI_RELAYER) {
    console.error(`[chain/relay] DOQTRI_RELAYER_SECRET is ${kp.publicKey()}, but the app names ${DOQTRI_RELAYER} as the relayer`);
    throw new RelayRejection("Paid writes are misconfigured on this server", 503);
  }
  return kp;
}

/** `func` with the forwarder's `fee_amount` (argument 1) replaced. */
function withFee(func: xdr.HostFunction, fee: bigint): xdr.HostFunction {
  const invoke = func.invokeContract();
  const args = [...invoke.args()];
  args[1] = nativeToScVal(fee, { type: "i128" });
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: invoke.contractAddress(),
      functionName: invoke.functionName(),
      args,
    }),
  );
}

/** The relayer's own approval of exactly this `forward` call (it has no sub-calls). */
async function relayerAuth(func: xdr.HostFunction, kp: Keypair, latestLedger: number) {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: xdr.ScAddress.scAddressTypeAccount(kp.xdrAccountId()),
        nonce: xdr.Int64.fromString(String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(func.invokeContract()),
      subInvocations: [],
    }),
  });
  return authorizeEntry(entry, kp, latestLedger + RELAYER_AUTH_LEDGERS, NETWORK_PASSPHRASE);
}

/** How long a "the relayer has enough XLM" check is trusted before Horizon is asked again. */
const FUNDED_CHECK_TTL_MS = 5 * 60_000;
let fundedCheckedAt = 0;

async function ensureRelayerFunded(publicKey: string): Promise<void> {
  if (IS_MAINNET) return;
  // Every paid write used to wait on a Horizon round trip here. The relayer
  // spends well under a lumen per write against a 1,000 XLM floor, so one
  // check every few minutes is plenty.
  if (Date.now() - fundedCheckedAt < FUNDED_CHECK_TTL_MS) return;
  fundedCheckedAt = Date.now();
  try {
    const account = await new Horizon.Server(HORIZON_URL).loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === "native");
    if (native && Number(native.balance) >= TESTNET_REFILL_BELOW_XLM) return;
  } catch {
    // Not created yet: Friendbot creates it.
  }
  await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`).catch(() => undefined);
}

/**
 * confirmed: a ledger has it. pending: accepted, but not found within the
 * poll window; it may still land until its 60 s time bound passes.
 */
export type PaidWriteStatus = "confirmed" | "pending";

export type PaidWriteResult = { hash: string; feeStroops: bigint; status: PaidWriteStatus };

/** One-second checks for an accepted write before it is reported pending (~20 s). */
const POLL_ATTEMPTS = 20;

/**
 * What polling an accepted write came to. Still NOT_FOUND after the poll
 * window is pending, not a failure: the network took it and may yet include
 * it. FAILED is final, and the caller hears 502 as before.
 */
async function pollPaidWrite(
  server: Pick<rpc.Server, "pollTransaction">,
  hash: string,
  feeStroops: bigint,
): Promise<PaidWriteResult> {
  const result = await server.pollTransaction(hash, { attempts: POLL_ATTEMPTS });
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash, feeStroops, status: "confirmed" };
  if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    console.warn(`[chain/relay] paid write ${hash} not confirmed within the poll window; reporting it pending`);
    return { hash, feeStroops, status: "pending" };
  }
  console.error(`[chain/relay] paid write ${hash} ended ${result.status}`);
  throw new RelayRejection("The transaction failed on-chain.", 502);
}

/**
 * Prices, signs and submits one forwarded write. `walletEntry` is the wallet's
 * passkey-signed approval; `maxFee` is what the user signed as the most they
 * will pay. From a leased channel when RELAY_POOL is on, else from the relayer.
 * `deps` stand in for the network and the pool in tests; the relayer path
 * takes none.
 */
export async function submitPaidWrite(
  func: xdr.HostFunction,
  walletEntry: xdr.SorobanAuthorizationEntry,
  maxFee: bigint,
  deps: ChannelWriteDeps = {},
): Promise<PaidWriteResult> {
  if (relayPoolEnabled()) return submitFromChannel(func, walletEntry, maxFee, deps);
  return submitFromRelayer(func, walletEntry, maxFee);
}

/** The relayer as the transaction source: one write per ledger at most (RELAY_POOL off). */
async function submitFromRelayer(
  func: xdr.HostFunction,
  walletEntry: xdr.SorobanAuthorizationEntry,
  maxFee: bigint,
): Promise<PaidWriteResult> {
  const kp = relayerKeypair();
  const server = new rpc.Server(RPC_URL);
  await ensureRelayerFunded(kp.publicKey());

  // The latest ledger and the relayer's sequence number are read once and
  // shared by the measuring and charging builds (testnet RPC takes a second or
  // more per read); a stale sequence on submit refreshes them.
  const chainState = async () => {
    const [{ sequence }, account] = await Promise.all([server.getLatestLedger(), server.getAccount(kp.publicKey())]);
    return { latestLedger: sequence, accountId: account.accountId(), accountSequence: account.sequenceNumber() };
  };
  let state = await chainState();

  const build = async (fee: bigint) => {
    const priced = withFee(func, fee);
    const auth = [walletEntry, await relayerAuth(priced, kp, state.latestLedger)];
    // TransactionBuilder bumps the account's sequence, so each build gets a fresh copy.
    const source = new Account(state.accountId, state.accountSequence);
    const tx = new TransactionBuilder(source, { fee: String(INCLUSION_FEE), networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.invokeHostFunction({ func: priced, auth }))
      .setTimeout(60)
      .build();
    const simulation = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(simulation) || rpc.Api.isSimulationRestore(simulation)) {
      const detail = rpc.Api.isSimulationError(simulation) ? simulation.error : "needs a restore";
      console.error(`[chain/relay] paid write simulation failed: ${String(detail).slice(0, 300)}`);
      if (/balance|insufficient|#10\b/i.test(String(detail))) {
        throw new RelayRejection("Your wallet doesn't have enough XLM for this. Top it up and try again.", 402);
      }
      throw new RelayRejection("The transaction would fail on-chain", 422);
    }
    return { tx, simulation };
  };

  // 1. Measure with a token fee: the signatures are in place, so the resource
  //    fee includes verifying the passkey.
  const measured = await build(BigInt(1));
  const fee = BigInt(measured.simulation.minResourceFee) + BigInt(INCLUSION_FEE);
  if (fee > maxFee) {
    throw new RelayRejection("This write costs more than the most you approved. Try again.", 409);
  }

  // 2. Charge exactly that, then submit. A stale sequence number means another
  //    write went out from the relayer in between: rebuild and retry.
  for (let attempt = 1; ; attempt++) {
    const { tx, simulation } = await build(fee);
    const prepared = rpc.assembleTransaction(tx, simulation).build();
    prepared.sign(kp);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      const code = sent.errorResult?.result().switch().name ?? sent.status;
      if (attempt < 3 && (code === "txBadSeq" || sent.status === "TRY_AGAIN_LATER")) {
        state = await chainState();
        continue;
      }
      console.error(`[chain/relay] paid write rejected: ${code}`);
      throw new RelayRejection("The network rejected this transaction. Try again.", 502);
    }
    return pollPaidWrite(server, sent.hash, fee);
  }
}

// --- RELAY_POOL=on: a leased channel account as the source (DOQ-4) ---

/** Submission attempts per write, as on the relayer path. */
const CHANNEL_SUBMIT_ATTEMPTS = 3;
/** How often a retry asks the RPC whether the next ledger has closed. */
const NEXT_LEDGER_POLL_MS = 1_000;
/** A ledger closes about every 5 s; a retry waits for the next one no longer than this. */
const NEXT_LEDGER_WAIT_MS = 12_000;
/**
 * Room for the database's clock running ahead of this server's: the lease's
 * end comes from the one, the transaction's time bound from the other.
 */
const LEASE_CLOCK_SKEW_MS = 5_000;
/** What a write that ran out of lease time is told to wait before trying again. */
const SLOW_NETWORK_RETRY_AFTER_SECONDS = 5;

/** The RPC calls a channel write makes; the real server, or a fake in tests. */
export type PaidWriteRpc = Pick<
  rpc.Server,
  "getLatestLedger" | "getAccount" | "simulateTransaction" | "sendTransaction" | "pollTransaction"
>;

export type ChannelWriteDeps = {
  server?: PaidWriteRpc;
  pool?: ChannelPoolStore;
  ensureFunded?: (publicKey: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Step timings (RELAY_TIMING, DOQ-8); by default on when the env says so. */
  timer?: PaidWriteTimer;
};

/** One write's hold on its channel. */
type ChannelWrite = {
  server: PaidWriteRpc;
  lease: ChannelLease;
  relayer: Keypair;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timer: PaidWriteTimer;
  /** When the lease was granted, by this server's clock. */
  leasedAt: number;
  /** What the lease is given back with: see "Releasing" in channel-pool.ts. */
  releaseSeq: bigint | null;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Leases a channel, submits from it, and gives it back whatever happened:
 * the finally runs on a refused simulation, a fee over the maximum and a
 * failed submission alike. With RELAY_TIMING=on, logs one timing line at the
 * end (paid-write-timing.ts).
 */
async function submitFromChannel(
  func: xdr.HostFunction,
  walletEntry: xdr.SorobanAuthorizationEntry,
  maxFee: bigint,
  deps: ChannelWriteDeps,
): Promise<PaidWriteResult> {
  const relayer = relayerKeypair();
  const seed = relayChannelSeed();
  const now = deps.now ?? Date.now;
  const timer = deps.timer ?? paidWriteTimer(now);
  try {
    const result = await leaseAndSend(func, walletEntry, maxFee, deps, { relayer, seed, now, timer });
    timer.finish({ status: result.status, hash: result.hash });
    return result;
  } catch (error) {
    timer.finish({ status: error instanceof RelayRejection ? String(error.status) : "error" });
    throw error;
  }
}

async function leaseAndSend(
  func: xdr.HostFunction,
  walletEntry: xdr.SorobanAuthorizationEntry,
  maxFee: bigint,
  deps: ChannelWriteDeps,
  { relayer, seed, now, timer }: { relayer: Keypair; seed: string; now: () => number; timer: PaidWriteTimer },
): Promise<PaidWriteResult> {
  const server = timer.rpc(deps.server ?? new rpc.Server(RPC_URL));
  const sleep = deps.sleep ?? defaultSleep;
  // The relayer still collects fee_amount and is still kept topped up on
  // testnet; channels pay their network fees from what they were seeded with.
  await timer.span("funded", () => (deps.ensureFunded ?? ensureRelayerFunded)(relayer.publicKey()));

  const pool = timer.pool(deps.pool ?? supabaseChannelPoolStore(createSupabaseAdminClient()));
  const lease = await timer.span("lease", () => leaseChannel(pool, { network: NETWORK, seed, now, sleep }));
  timer.channel(lease.idx);
  const write: ChannelWrite = { server, lease, relayer, now, sleep, timer, leasedAt: now(), releaseSeq: null };
  try {
    return await sendFromChannel(write, func, walletEntry, maxFee);
  } finally {
    await releaseChannel(pool, lease, write.releaseSeq);
  }
}

/** The relayer path's two simulations and submit loop, with the channel as source and signer. */
async function sendFromChannel(
  write: ChannelWrite,
  func: xdr.HostFunction,
  walletEntry: xdr.SorobanAuthorizationEntry,
  maxFee: bigint,
): Promise<PaidWriteResult> {
  const { server, lease } = write;
  // The lease's nextSeq is a floor under the RPC's read, which can lag a ledger.
  let floor = lease.nextSeq;
  let state = await write.timer.span("state", () => channelState(write));

  const build = async (fee: bigint) => {
    const priced = withFee(func, fee);
    const auth = [walletEntry, await relayerAuth(priced, write.relayer, state.latestLedger)];
    const seq = nextSequence(state.accountSequence, floor);
    // TransactionBuilder takes the account's current sequence and bumps it.
    const source = new Account(lease.publicKey, (seq - BigInt(1)).toString());
    const tx = new TransactionBuilder(source, { fee: String(INCLUSION_FEE), networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.invokeHostFunction({ func: priced, auth }))
      .setTimeout(PAID_WRITE_TIMEOUT_SECONDS)
      .build();
    const simulation = await server.simulateTransaction(tx);
    checkSimulation(simulation);
    return { tx, simulation, seq };
  };

  const measured = await build(BigInt(1));
  const fee = BigInt(measured.simulation.minResourceFee) + BigInt(INCLUSION_FEE);
  if (fee > maxFee) {
    throw new RelayRejection("This write costs more than the most you approved. Try again.", 409);
  }

  for (let attempt = 1; ; attempt++) {
    checkLeaseTime(write);
    const { tx, simulation, seq } = await build(fee);
    const prepared = rpc.assembleTransaction(tx, simulation).build();
    prepared.sign(lease.keypair);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      const code = sent.errorResult?.result().switch().name ?? sent.status;
      const badSeq = code === "txBadSeq";
      if (attempt < CHANNEL_SUBMIT_ATTEMPTS && (badSeq || sent.status === "TRY_AGAIN_LATER")) {
        // The sequence number just used was wrong. If the floor chose it, the
        // floor is wrong (a write counted as sent never landed); if the RPC
        // chose it, the floor was already below the RPC's read. Either way the
        // fresh read after the next ledger decides from here.
        if (badSeq) floor = null;
        // Retrying in the same ledger only meets the same refusal.
        await write.timer.span("retryWait", () => waitForNextLedger(write));
        state = await write.timer.span("state", () => channelState(write));
        if (badSeq) write.releaseSeq = state.accountSequence + BigInt(1);
        continue;
      }
      if (badSeq) write.releaseSeq = (await rpcNextSequence(write)) ?? write.releaseSeq;
      console.error(`[chain/relay] paid write from channel ${lease.idx} rejected: ${code}`);
      throw new RelayRejection("The network rejected this transaction. Try again.", 502);
    }
    // Accepted: the sequence number is spent, or will be if it lands later,
    // so a pending write releases the channel with seq + 1 too.
    write.releaseSeq = seq + BigInt(1);
    return pollPaidWrite(server, sent.hash, fee);
  }
}

/** The sequence number the next transaction carries: the larger of the RPC's and the stored floor. */
function nextSequence(accountSequence: bigint, floor: bigint | null): bigint {
  const fromRpc = accountSequence + BigInt(1);
  return floor !== null && floor > fromRpc ? floor : fromRpc;
}

/** Throws the relayer path's refusal for a simulation that failed or needs a restore. */
function checkSimulation(
  simulation: rpc.Api.SimulateTransactionResponse,
): asserts simulation is rpc.Api.SimulateTransactionSuccessResponse {
  if (rpc.Api.isSimulationSuccess(simulation) && !rpc.Api.isSimulationRestore(simulation)) return;
  const detail = rpc.Api.isSimulationError(simulation) ? simulation.error : "needs a restore";
  console.error(`[chain/relay] paid write simulation failed: ${String(detail).slice(0, 300)}`);
  if (/balance|insufficient|#10\b/i.test(String(detail))) {
    throw new RelayRejection("Your wallet doesn't have enough XLM for this. Top it up and try again.", 402);
  }
  throw new RelayRejection("The transaction would fail on-chain", 422);
}

/**
 * Refuses to build once the lease could end inside the transaction's time
 * bound: past that, an expired lease could hand the channel to another write
 * while this one might still land.
 */
function checkLeaseTime(write: ChannelWrite): void {
  const elapsed = write.now() - write.leasedAt;
  if (elapsed <= LEASE_BUILD_BUDGET_SECONDS * 1000 - LEASE_CLOCK_SKEW_MS) return;
  console.error(`[chain/relay] channel ${write.lease.idx} held ${elapsed} ms without a submission; giving up`);
  throw new RelayRejection("The network is slow right now. Try again in a few seconds.", 503, SLOW_NETWORK_RETRY_AFTER_SECONDS);
}

/** The latest ledger and the channel's sequence number, read together. */
async function channelState(write: ChannelWrite) {
  const [{ sequence }, account] = await Promise.all([write.server.getLatestLedger(), loadChannel(write)]);
  return { latestLedger: sequence, accountSequence: BigInt(account.sequenceNumber()) };
}

/** The channel's account; a 503 when it was never created (the pool wasn't seeded on this network). */
async function loadChannel(write: ChannelWrite) {
  const { idx, publicKey } = write.lease;
  try {
    return await write.server.getAccount(publicKey);
  } catch (error) {
    if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
    console.error(`[chain/relay] channel ${idx} (${publicKey}) has no account on-chain. Run scripts/seed-relay-channels.mjs`);
    throw new RelayRejection("Paid writes are misconfigured on this server", 503);
  }
}

/** The RPC's next sequence number for the channel, read after a refusal; null when it can't be read. */
async function rpcNextSequence(write: ChannelWrite): Promise<bigint | null> {
  try {
    const account = await write.server.getAccount(write.lease.publicKey);
    return BigInt(account.sequenceNumber()) + BigInt(1);
  } catch {
    return null;
  }
}

/**
 * Waits until the RPC has closed a ledger past the one it is on now, so the
 * rebuilt transaction reads a sequence number that counts whatever the network
 * just refused it over. Bounded: after NEXT_LEDGER_WAIT_MS the retry runs anyway.
 */
async function waitForNextLedger(write: ChannelWrite): Promise<void> {
  const from = (await write.server.getLatestLedger()).sequence;
  const deadline = write.now() + NEXT_LEDGER_WAIT_MS;
  while (write.now() < deadline) {
    await write.sleep(NEXT_LEDGER_POLL_MS);
    if ((await write.server.getLatestLedger()).sequence > from) return;
  }
  console.warn(`[chain/relay] no ledger after ${from} within ${NEXT_LEDGER_WAIT_MS} ms; retrying anyway`);
}
