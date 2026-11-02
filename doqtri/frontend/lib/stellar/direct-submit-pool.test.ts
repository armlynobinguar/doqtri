import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  SorobanDataBuilder,
  StrKey,
  type Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelKeypair } from "@/lib/stellar/channel-accounts.mjs";
import type { ChannelPoolStore, LeasedRow } from "@/lib/stellar/channel-pool";

// Paid writes from a leased channel (RELAY_POOL=on, DOQ-4) against a fake
// RPC whose ledger closes every 5 s of a clock that only moves when the code
// sleeps. The relayer path makes its own rpc.Server and asks Horizon whether
// the relayer is funded, so those two are swapped for the same fake here.

const fakes = vi.hoisted(() => ({ server: null as unknown }));
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: { ...actual.rpc, Server: function Server() { return fakes.server; } },
    Horizon: {
      ...actual.Horizon,
      Server: function Server() {
        return { loadAccount: async () => ({ balances: [{ asset_type: "native", balance: "5000" }] }) };
      },
    },
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: () => {
    throw new Error("tests pass their own pool");
  },
}));

const seed = "a-test-relay-channel-seed-of-40-chars-xx";
const leaseId = "5f1c0000-0000-4000-8000-000000000001";
const relayer = Keypair.random();
const channelIdx = 3;
const channel = channelKeypair(seed, "testnet", channelIdx);
const LEDGER_MS = 5_000;
const RESOURCE_FEE = 50_000;
const INCLUSION_FEE = 1_000;

type SendOutcome = "PENDING" | "TRY_AGAIN_LATER" | "txBadSeq" | "txInsufficientBalance";

/** A Soroban RPC with one account per address, a ledger every 5 s, and scripted submit outcomes. */
function fakeChain(
  options: { sequences?: Record<string, bigint>; sends?: SendOutcome[]; simulationError?: string; simulateMs?: number } = {},
) {
  const clock = { t: 0 };
  const sequences: Record<string, bigint> = { [channel.publicKey()]: BigInt(500), [relayer.publicKey()]: BigInt(9000), ...options.sequences };
  const sends = [...(options.sends ?? [])];
  const ledger = () => 100 + Math.floor(clock.t / LEDGER_MS);
  const simulated: { ledger: number; source: string; sequence: string }[] = [];
  const submitted: { ledger: number; tx: Transaction; outcome: SendOutcome }[] = [];
  const server = {
    async getLatestLedger() {
      return { id: "x", sequence: ledger(), protocolVersion: 23 };
    },
    async getAccount(address: string) {
      const sequence = sequences[address];
      if (sequence === undefined) throw new Error(`Account not found: ${address}`);
      return new Account(address, sequence.toString());
    },
    async simulateTransaction(tx: Transaction) {
      clock.t += options.simulateMs ?? 0;
      simulated.push({ ledger: ledger(), source: tx.source, sequence: tx.sequence });
      const base = { _parsed: true, id: "1", latestLedger: ledger(), events: [] };
      if (options.simulationError) return { ...base, error: options.simulationError };
      return {
        ...base,
        transactionData: new SorobanDataBuilder(),
        minResourceFee: String(RESOURCE_FEE),
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      };
    },
    async sendTransaction(tx: Transaction) {
      const outcome = sends.shift() ?? "PENDING";
      submitted.push({ ledger: ledger(), tx, outcome });
      if (outcome === "PENDING") {
        sequences[tx.source] = BigInt(tx.sequence);
        return { status: "PENDING", hash: `hash-${tx.sequence}`, latestLedger: ledger(), latestLedgerCloseTime: 0 };
      }
      if (outcome === "TRY_AGAIN_LATER") return { status: "TRY_AGAIN_LATER", hash: "h", latestLedger: ledger() };
      return {
        status: "ERROR",
        hash: "h",
        latestLedger: ledger(),
        errorResult: { result: () => ({ switch: () => ({ name: outcome }) }) },
      };
    },
    async pollTransaction() {
      return { status: "SUCCESS" };
    },
  };
  const sleep = async (ms: number) => void (clock.t += ms);
  return { clock, server, sequences, simulated, submitted, sleep, now: () => clock.t, ledger };
}

/** Hands out channel 3 with `nextSeq`, once; records releases. */
function memoryPool(nextSeq: bigint | null = null) {
  const released: { idx: number; leaseId: string; nextSeq: bigint | null }[] = [];
  let leases = 0;
  const store: ChannelPoolStore = {
    async lease() {
      leases++;
      const row: LeasedRow = {
        idx: channelIdx,
        lease_id: leaseId,
        next_seq: nextSeq === null ? null : nextSeq.toString(),
        public_key: channel.publicKey(),
      };
      return leases === 1 ? row : null;
    },
    async release(idx, id, seq) {
      released.push({ idx, leaseId: id, nextSeq: seq });
      return true;
    },
  };
  return { store, released, leases: () => leases };
}

const forwarder = StrKey.encodeContract(Buffer.alloc(32, 7));
const wallet = StrKey.encodeContract(Buffer.alloc(32, 9));

/** A forward() call with fee_amount as argument 1, as the FeeForwarder takes it. */
function forwardCall() {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(forwarder).toScAddress(),
      functionName: "forward",
      args: [Address.fromString(wallet).toScVal(), nativeToScVal(BigInt(0), { type: "i128" })],
    }),
  );
}

/** The wallet's approval; its signature isn't checked by the fake. */
function walletEntry(func: xdr.HostFunction) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(wallet).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(func.invokeContract()),
      subInvocations: [],
    }),
  });
}

async function load() {
  vi.resetModules();
  return import("./direct-submit");
}

/** Submits one write through `chain` and `pool` with the given maximum fee. */
async function submit(chain: ReturnType<typeof fakeChain>, pool: ReturnType<typeof memoryPool>, maxFee = BigInt(100_000)) {
  fakes.server = chain.server;
  const { submitPaidWrite } = await load();
  const func = forwardCall();
  return submitPaidWrite(func, walletEntry(func), maxFee, {
    server: chain.server as never,
    pool: pool.store,
    ensureFunded: async () => {},
    now: chain.now,
    sleep: chain.sleep,
  });
}

function signedBy(tx: Transaction, kp: Keypair) {
  return tx.signatures.some((s) => s.hint().equals(kp.signatureHint()));
}

/** The account an auth entry's address credentials name. */
function authAddress(entry: xdr.SorobanAuthorizationEntry) {
  return Address.fromScAddress(entry.credentials().address().address()).toString();
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DOQTRI_RELAYER", relayer.publicKey());
  vi.stubEnv("DOQTRI_RELAYER_SECRET", relayer.secret());
  vi.stubEnv("RELAY_CHANNEL_SEED", seed);
  vi.stubEnv("RELAY_POOL", "on");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fakes.server = null;
});

describe("RELAY_POOL", () => {
  it("is on only when set to on", async () => {
    const { relayPoolEnabled } = await import("./channel-pool");
    for (const value of ["on", " ON ", '"on"']) {
      vi.stubEnv("RELAY_POOL", value);
      expect(relayPoolEnabled()).toBe(true);
    }
    for (const value of ["", "off", "1", "true"]) {
      vi.stubEnv("RELAY_POOL", value);
      expect(relayPoolEnabled()).toBe(false);
    }
  });

  it("off: the relayer is the source and signer, and no channel is leased", async () => {
    vi.stubEnv("RELAY_POOL", "");
    const chain = fakeChain();
    const pool = memoryPool();
    const result = await submit(chain, pool);
    expect(pool.leases()).toBe(0);
    expect(pool.released).toEqual([]);
    const [sent] = chain.submitted;
    expect(sent.tx.source).toBe(relayer.publicKey());
    expect(signedBy(sent.tx, relayer)).toBe(true);
    expect(result.feeStroops).toBe(BigInt(RESOURCE_FEE + INCLUSION_FEE));
    expect(result.status).toBe("confirmed");
  });

  it("off: a write not confirmed within the poll window comes back pending, not 502", async () => {
    vi.stubEnv("RELAY_POOL", "");
    const chain = fakeChain();
    chain.server.pollTransaction = async () => ({ status: "NOT_FOUND" });
    const result = await submit(chain, memoryPool());
    expect(result.status).toBe("pending");
    expect(result.hash).toBe("hash-9001");
  });
});

describe("submitPaidWrite from a leased channel", () => {
  it("uses the channel as source and envelope signer; the relayer only approves forward() and still gets the fee", async () => {
    const chain = fakeChain();
    const pool = memoryPool();
    const result = await submit(chain, pool);

    expect(chain.simulated.every((s) => s.source === channel.publicKey())).toBe(true);
    expect(chain.submitted).toHaveLength(1);
    const { tx } = chain.submitted[0];
    expect(tx.source).toBe(channel.publicKey());
    expect(tx.sequence).toBe("501");
    expect(signedBy(tx, channel)).toBe(true);
    expect(signedBy(tx, relayer)).toBe(false);

    const op = tx.operations[0] as unknown as { func: xdr.HostFunction; auth: xdr.SorobanAuthorizationEntry[] };
    expect(op.auth.map(authAddress)).toEqual([wallet, relayer.publicKey()]);
    const fee = op.func.invokeContract().args()[1];
    expect(fee.i128().lo().toBigInt()).toBe(BigInt(RESOURCE_FEE + INCLUSION_FEE));
    expect(result).toEqual({ hash: "hash-501", feeStroops: BigInt(RESOURCE_FEE + INCLUSION_FEE), status: "confirmed" });

    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: BigInt(502) }]);
  });

  it("builds from the lease's next_seq when the RPC hasn't caught up with it", async () => {
    const chain = fakeChain();
    const pool = memoryPool(BigInt(510));
    await submit(chain, pool);
    expect(chain.submitted[0].tx.sequence).toBe("510");
    expect(pool.released[0].nextSeq).toBe(BigInt(511));
  });

  it("builds from the RPC's sequence when it is past the lease's next_seq", async () => {
    const chain = fakeChain({ sequences: { [channel.publicKey()]: BigInt(520) } });
    await submit(chain, memoryPool(BigInt(510)));
    expect(chain.submitted[0].tx.sequence).toBe("521");
  });

  it("waits at least one ledger after txBadSeq before rebuilding", async () => {
    const chain = fakeChain({ sends: ["txBadSeq"] });
    const pool = memoryPool();
    await submit(chain, pool);

    expect(chain.submitted.map((s) => s.outcome)).toEqual(["txBadSeq", "PENDING"]);
    const refusedAt = chain.submitted[0].ledger;
    // Simulations: measure, charge (refused), charge again.
    expect(chain.simulated).toHaveLength(3);
    expect(chain.simulated[2].ledger).toBeGreaterThan(refusedAt);
    expect(chain.submitted[1].ledger).toBeGreaterThan(refusedAt);
  });

  it("waits a ledger after TRY_AGAIN_LATER too", async () => {
    const chain = fakeChain({ sends: ["TRY_AGAIN_LATER"] });
    await submit(chain, memoryPool());
    expect(chain.submitted[1].ledger).toBeGreaterThan(chain.submitted[0].ledger);
  });

  it("drops a next_seq the network refused with txBadSeq and retries from the RPC's sequence", async () => {
    // next_seq 510 was stored for a write that never landed; the chain is at 500.
    const chain = fakeChain({ sends: ["txBadSeq"] });
    const pool = memoryPool(BigInt(510));
    await submit(chain, pool);
    expect(chain.submitted.map((s) => s.tx.sequence)).toEqual(["510", "501"]);
    expect(pool.released[0].nextSeq).toBe(BigInt(502));
  });

  it("gives up after three refusals with a 502 and releases with the RPC's next sequence number", async () => {
    const chain = fakeChain({ sends: ["txBadSeq", "txBadSeq", "txBadSeq"] });
    const pool = memoryPool(BigInt(510));
    await expect(submit(chain, pool)).rejects.toMatchObject({ status: 502 });
    expect(chain.submitted).toHaveLength(3);
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: BigInt(501) }]);
  });
});

describe("the lease is released", () => {
  it("when simulation fails, keeping the stored next_seq", async () => {
    const chain = fakeChain({ simulationError: "HostError: contract trapped" });
    const pool = memoryPool(BigInt(510));
    await expect(submit(chain, pool)).rejects.toMatchObject({ status: 422 });
    expect(chain.submitted).toHaveLength(0);
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: null }]);
  });

  it("when the fee is over the maximum (409)", async () => {
    const chain = fakeChain();
    const pool = memoryPool();
    await expect(submit(chain, pool, BigInt(RESOURCE_FEE))).rejects.toMatchObject({ status: 409 });
    expect(chain.submitted).toHaveLength(0);
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: null }]);
  });

  it("when submission fails without spending the sequence number", async () => {
    const chain = fakeChain({ sends: ["txInsufficientBalance"] });
    const pool = memoryPool();
    await expect(submit(chain, pool)).rejects.toMatchObject({ status: 502 });
    expect(chain.submitted).toHaveLength(1);
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: null }]);
  });

  it("when the transaction was accepted but failed on-chain, with the spent sequence number + 1", async () => {
    const chain = fakeChain();
    chain.server.pollTransaction = async () => ({ status: "FAILED" });
    const pool = memoryPool();
    await expect(submit(chain, pool)).rejects.toMatchObject({ status: 502 });
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: BigInt(502) }]);
  });

  it("when the transaction was accepted but not confirmed within the poll window: pending, with the spent sequence number + 1", async () => {
    const chain = fakeChain();
    const polled: { hash: string; attempts?: number }[] = [];
    // The fake's own pollTransaction takes no arguments; this one records them.
    chain.server.pollTransaction = (async (hash: string, opts?: { attempts?: number }) => {
      polled.push({ hash, attempts: opts?.attempts });
      return { status: "NOT_FOUND" };
    }) as never;
    const pool = memoryPool();
    const result = await submit(chain, pool);
    expect(polled).toEqual([{ hash: "hash-501", attempts: 20 }]);
    expect(result).toEqual({ hash: "hash-501", feeStroops: BigInt(RESOURCE_FEE + INCLUSION_FEE), status: "pending" });
    // The next holder builds from 502, as the pending write may still take 501.
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: BigInt(502) }]);
  });

  it("when polling throws after the transaction was accepted", async () => {
    const chain = fakeChain();
    chain.server.pollTransaction = async () => {
      throw new Error("socket hang up");
    };
    const pool = memoryPool();
    await expect(submit(chain, pool)).rejects.toThrow("socket hang up");
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: BigInt(502) }]);
  });

  it("when the channel has no account on-chain (503)", async () => {
    const chain = fakeChain();
    delete chain.sequences[channel.publicKey()];
    const pool = memoryPool();
    await expect(submit(chain, pool)).rejects.toMatchObject({ status: 503, message: "Paid writes are misconfigured on this server" });
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: null }]);
  });

  it("when retries run past the time the lease leaves for building (503 with Retry-After)", async () => {
    // Slow simulations, and ledgers stop closing, so each retry waits out the full 12 s.
    const chain = fakeChain({ sends: ["TRY_AGAIN_LATER", "TRY_AGAIN_LATER"], simulateMs: 1_500 });
    chain.server.getLatestLedger = async () => ({ id: "x", sequence: 100, protocolVersion: 23 });
    const pool = memoryPool();
    await expect(submit(chain, pool)).rejects.toMatchObject({ status: 503, retryAfterSeconds: 5 });
    expect(chain.submitted).toHaveLength(2);
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: null }]);
  });
});

describe("step timings (RELAY_TIMING, DOQ-8)", () => {
  const timingLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith("[chain/relay] timing "));
  const parse = (line: string) => JSON.parse(line.slice("[chain/relay] timing ".length));

  it("logs nothing when RELAY_TIMING is unset", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await submit(fakeChain(), memoryPool());
    expect(timingLines(info)).toEqual([]);
  });

  it("logs one line per write when RELAY_TIMING=on, without changing what the RPC is asked", async () => {
    vi.stubEnv("RELAY_TIMING", "on");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const chain = fakeChain();
    const polled: { hash: string; attempts?: number }[] = [];
    chain.server.pollTransaction = (async (hash: string, opts?: { attempts?: number }) => {
      polled.push({ hash, attempts: opts?.attempts });
      return { status: "SUCCESS", ledger: chain.ledger() + 1, createdAt: 0 };
    }) as never;
    const pool = memoryPool();
    const result = await submit(chain, pool);
    expect(result.status).toBe("confirmed");
    expect(polled).toEqual([{ hash: "hash-501", attempts: 20 }]);
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: BigInt(502) }]);
    const lines = timingLines(info);
    expect(lines).toHaveLength(1);
    expect(parse(lines[0])).toMatchObject({ v: 1, path: "pool", status: "confirmed", hash: "hash-501", channel: channelIdx, attempts: 1 });
    // No key, seed or URL in the line.
    expect(lines[0]).not.toContain(relayer.secret());
    expect(lines[0]).not.toContain(seed);
    expect(lines[0]).not.toMatch(/https?:/);
  });

  it("times each step on the write's clock, and the ledger it landed in", async () => {
    const lines: string[] = [];
    const { createPaidWriteTimer } = await import("./paid-write-timing");
    const chain = fakeChain({ simulateMs: 300 });
    const wall = { t: 1_800_000_000_000 };
    chain.server.pollTransaction = (async (_hash: string, opts?: { sleepStrategy?: (attempt: number) => number }) => {
      // Two rounds that find nothing, then a ledger closes and the third finds it.
      for (const attempt of [1, 2]) await chain.sleep(opts!.sleepStrategy!(attempt));
      wall.t += 2_000;
      return { status: "SUCCESS", ledger: 101, createdAt: Math.floor((wall.t - 600) / 1000) };
    }) as never;
    fakes.server = chain.server;
    const { submitPaidWrite } = await load();
    const func = forwardCall();
    const pool = memoryPool();
    await submitPaidWrite(func, walletEntry(func), BigInt(100_000), {
      server: chain.server as never,
      pool: pool.store,
      ensureFunded: async () => {},
      now: chain.now,
      sleep: chain.sleep,
      timer: createPaidWriteTimer(chain.now, () => wall.t, (line) => lines.push(line)),
    });
    expect(lines).toHaveLength(1);
    const timing = parse(lines[0]);
    expect(timing.ms).toMatchObject({ lease: 0, state: 0, simulateMeasure: 300, simulateCharge: 300, send: 0, poll: 2_000, release: 0 });
    expect(timing.totalMs).toBe(2_600);
    expect(timing.otherMs).toBe(0);
    expect(timing).toMatchObject({ leaseTries: 1, attempts: 1, pollRounds: 3, sentLedger: 100, landedLedger: 101 });
    expect(timing.pollAfterCloseMs).toBeGreaterThanOrEqual(600);
    expect(timing.pollAfterCloseMs).toBeLessThan(1_600);
  });

  it("counts retries and logs a refused write with its HTTP status", async () => {
    const lines: string[] = [];
    const { createPaidWriteTimer } = await import("./paid-write-timing");
    const chain = fakeChain({ sends: ["txBadSeq", "txBadSeq", "txBadSeq"] });
    fakes.server = chain.server;
    const { submitPaidWrite } = await load();
    const func = forwardCall();
    const pool = memoryPool(BigInt(510));
    await expect(
      submitPaidWrite(func, walletEntry(func), BigInt(100_000), {
        server: chain.server as never,
        pool: pool.store,
        ensureFunded: async () => {},
        now: chain.now,
        sleep: chain.sleep,
        timer: createPaidWriteTimer(chain.now, () => 0, (line) => lines.push(line)),
      }),
    ).rejects.toMatchObject({ status: 502 });
    const timing = parse(lines[0]);
    expect(timing).toMatchObject({ status: "502", hash: null, attempts: 3, sentLedger: null, landedLedger: null });
    expect(timing.calls).toMatchObject({ simulateCharge: 3, state: 3, retryWait: 2 });
    expect(timing.ms.retryWait).toBeGreaterThanOrEqual(2 * LEDGER_MS);
    // Still released, as without timing.
    expect(pool.released).toEqual([{ idx: channelIdx, leaseId, nextSeq: BigInt(501) }]);
  });
});
