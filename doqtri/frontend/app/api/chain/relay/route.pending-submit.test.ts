import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  nativeToScVal,
  SorobanDataBuilder,
  StrKey,
  type Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { channelKeypair } from "@/lib/stellar/channel-accounts.mjs";

/*
 * A paid note write that the network takes but no ledger has within the
 * relay's poll window (DOQ-5), end to end through the route with the real
 * submitPaidWrite: RELAY_POOL on, a fake RPC whose pollTransaction never
 * finds the transaction, and the channel pool's lease and release calls
 * answered by a fake service-role client. Checked: the 202, the pending
 * chain_writes row, and that the channel goes back with the spent sequence
 * number + 1. The shape checks and the write's authorization are stood in;
 * route.pending.test.ts covers the answers for each status on their own.
 */

const seed = "a-test-relay-channel-seed-of-40-chars-xx";
const leaseId = "5f1c0000-0000-4000-8000-000000000002";
const channelIdx = 4;
const channel = channelKeypair(seed, "testnet", channelIdx);
const forwarder = StrKey.encodeContract(Buffer.alloc(32, 7));
const wallet = StrKey.encodeContract(Buffer.alloc(32, 9));
const docId = "51000000-0000-4000-8000-000000000002";

const state = vi.hoisted(() => ({
  relayerSecret: "",
  relayerPublic: "",
  channelPublic: "",
  server: null as unknown,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("@/lib/stellar/smart-wallet-config", async (importOriginal) => {
  // A throwaway relayer key, made fresh for this run.
  const { Keypair } = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  const relayer = Keypair.random();
  state.relayerSecret = relayer.secret();
  state.relayerPublic = relayer.publicKey();
  return {
    ...(await importOriginal<typeof import("@/lib/stellar/smart-wallet-config")>()),
    FEE_FORWARDER: StrKey.encodeContract(Buffer.alloc(32, 7)),
    DOQTRI_RELAYER: relayer.publicKey(),
    USER_PAYS_FEES: true,
    NETWORK: "testnet",
  };
});

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: { ...actual.rpc, Server: function Server() { return state.server; } },
    Horizon: {
      ...actual.Horizon,
      Server: function Server() {
        return { loadAccount: async () => ({ balances: [{ asset_type: "native", balance: "5000" }] }) };
      },
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "writer@example.com" } } }) },
  }),
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { address: StrKey.encodeContract(Buffer.alloc(32, 9)) }, error: null }),
        insert: async (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return { error: null };
        },
      };
      return query;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      if (fn === "consume_chain_quota") return { data: [{ allowed: true, scope: null }], error: null };
      if (fn === "lease_relay_channel") {
        return {
          data: [{ idx: 4, lease_id: "5f1c0000-0000-4000-8000-000000000002", next_seq: null, public_key: state.channelPublic }],
          error: null,
        };
      }
      if (fn === "release_relay_channel") return { data: true, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

/** A forward() call with fee_amount as argument 1, and the wallet's approval of it. */
function forwardSubmission() {
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(forwarder).toScAddress(),
      functionName: "forward",
      args: [Address.fromString(wallet).toScVal(), nativeToScVal(BigInt(0), { type: "i128" })],
    }),
  );
  const entry = new xdr.SorobanAuthorizationEntry({
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
  return { func, auth: [entry] };
}

vi.mock("@/lib/stellar/relay-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/relay-validation")>()),
  parseRelayBody: () => forwardSubmission(),
  forwardedTarget: () => null,
  validateForwardedWrite: () => ({ fn: "anchor", docId, maxFee: BigInt(100_000), expirationLedger: 1 }),
  authorizeRegistryWrite: async () => {},
}));

/** An RPC that takes every transaction and never finds it again. */
function neverConfirms() {
  const sequences: Record<string, bigint> = { [channel.publicKey()]: BigInt(700), [state.relayerPublic]: BigInt(9000) };
  const polled: { hash: string; attempts?: number }[] = [];
  const submitted: Transaction[] = [];
  const server = {
    async getLatestLedger() {
      return { id: "x", sequence: 100, protocolVersion: 23 };
    },
    async getAccount(address: string) {
      const sequence = sequences[address];
      if (sequence === undefined) throw new Error(`Account not found: ${address}`);
      return new Account(address, sequence.toString());
    },
    async simulateTransaction() {
      return {
        _parsed: true,
        id: "1",
        latestLedger: 100,
        events: [],
        transactionData: new SorobanDataBuilder(),
        minResourceFee: "50000",
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      };
    },
    async sendTransaction(tx: Transaction) {
      submitted.push(tx);
      return { status: "PENDING", hash: `hash-${tx.sequence}`, latestLedger: 100, latestLedgerCloseTime: 0 };
    },
    async pollTransaction(hash: string, options?: { attempts?: number }) {
      polled.push({ hash, attempts: options?.attempts });
      return { status: "NOT_FOUND" };
    },
  };
  return { server, polled, submitted };
}

state.channelPublic = channel.publicKey();

const { POST } = await import("./route");

beforeEach(() => {
  vi.stubEnv("DOQTRI_RELAYER_SECRET", state.relayerSecret);
  vi.stubEnv("RELAY_CHANNEL_SEED", seed);
  vi.stubEnv("RELAY_POOL", "on");
  state.inserts = [];
  state.rpcCalls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("POST /api/chain/relay, a paid note write from a leased channel that isn't confirmed in time", () => {
  it("answers 202 pending, indexes it as pending and gives the channel back with the spent sequence + 1", async () => {
    const chain = neverConfirms();
    state.server = chain.server;

    const res = await POST(new Request("https://doqtri.test/api/chain/relay", { method: "POST", body: "{}" }));

    expect(chain.submitted.map((tx) => [tx.source, tx.sequence])).toEqual([[channel.publicKey(), "701"]]);
    expect(chain.polled).toEqual([{ hash: "hash-701", attempts: 20 }]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: { hash: "hash-701", status: "pending", feeStroops: "51000" } });
    expect(state.inserts).toEqual([
      {
        table: "chain_writes",
        row: { network: "testnet", tx_hash: "hash-701", document_id: docId, fn: "anchor", owner: wallet, status: "pending" },
      },
    ]);
    expect(state.rpcCalls.filter((c) => c.fn === "release_relay_channel").map((c) => c.args)).toEqual([
      { p_idx: channelIdx, p_lease_id: leaseId, p_next_seq: "702" },
    ]);
    // Not yet a referral activity: it counts once the chain-jobs run settles it (DOQ-23).
    expect(state.rpcCalls.map((c) => c.fn)).not.toContain("record_referral_activity");
  });
});
