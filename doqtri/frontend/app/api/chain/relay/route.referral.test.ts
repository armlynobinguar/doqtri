import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { CONTRACT_ID } from "@/lib/stellar/config";

/*
 * Each write path of the relay and the referral program (DOQ-23): a confirmed
 * note, membership or market write is recorded as the caller's activity; a
 * pending one, a passkey change and a wallet deployment are not; and recording
 * waits for the response, so failing or hanging changes nothing about the
 * answer. The shape checks, the authorization and the submissions are stood in;
 * the recording is the real one, down to the rpc it makes.
 */

const wallet = StrKey.encodeContract(Buffer.alloc(32, 9));
const hash = "ab".repeat(32);

const state = vi.hoisted(() => ({
  userPaysFees: false,
  target: "",
  forwardedTo: null as string | null,
  deploying: false,
  write: {} as Record<string, unknown>,
  call: {} as Record<string, unknown>,
  paidStatus: "confirmed" as "confirmed" | "pending",
  recordFails: null as "refused" | "throws" | "hangs" | null,
  afterResponse: [] as (() => Promise<unknown>)[],
  afterRefuses: false,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  inserts: [] as string[],
}));

const forwarder = StrKey.encodeContract(Buffer.alloc(32, 7));
const marketContract = StrKey.encodeContract(Buffer.alloc(32, 6));

vi.mock("next/server", () => ({
  after: (callback: () => Promise<unknown>) => {
    if (state.afterRefuses) throw new Error("after() was called outside a request scope");
    state.afterResponse.push(callback);
  },
}));

vi.mock("@/lib/stellar/smart-wallet-config", async (importOriginal) => {
  const { StrKey: keys } = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...(await importOriginal<typeof import("@/lib/stellar/smart-wallet-config")>()),
    FEE_FORWARDER: keys.encodeContract(Buffer.alloc(32, 7)),
    DOQTRI_RELAYER: "G" + "A".repeat(55),
    get USER_PAYS_FEES() {
      return state.userPaysFees;
    },
    NETWORK: "testnet",
  };
});

vi.mock("@/lib/stellar/config", async (importOriginal) => {
  const { StrKey: keys } = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...(await importOriginal<typeof import("@/lib/stellar/config")>()),
    MARKET_CONTRACT_ID: keys.encodeContract(Buffer.alloc(32, 6)),
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
        delete: () => query,
        maybeSingle: async () => {
          if (state.deploying) return { data: null, error: null };
          if (table === "market_templates") return { data: { status: "listed", hidden: false }, error: null };
          return { data: { address: StrKey.encodeContract(Buffer.alloc(32, 9)) }, error: null };
        },
        insert: async () => {
          state.inserts.push(table);
          return { error: null };
        },
      };
      return query;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      if (fn === "consume_chain_quota") return { data: [{ allowed: true, scope: null }], error: null };
      if (fn === "record_referral_activity") {
        if (state.recordFails === "hangs") return new Promise(() => {});
        if (state.recordFails === "throws") throw new Error("no database");
        if (state.recordFails === "refused") return { data: null, error: { message: "refused" } };
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

vi.mock("@/lib/stellar/relay-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/relay-validation")>()),
  parseRelayBody: () => {
    if (state.deploying) return { func: { switch: () => ({ name: "hostFunctionTypeCreateContractV2" }) }, auth: [] };
    return {
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(state.target).toScAddress(),
          functionName: "call",
          args: [],
        }),
      ),
      auth: [],
    };
  },
  forwardedTarget: () => state.forwardedTo,
  validateRegistryWrite: () => state.write,
  validateForwardedWrite: () => state.write,
  authorizeRegistryWrite: async () => {},
  marketCallOf: () => state.call,
  forwardedMarketCallOf: () => state.call,
  validateMarketWrite: () => {},
  validateForwardedMarketWrite: () => ({ maxFee: BigInt(100_000) }),
  validateWalletAdmin: () => ({ fn: "add_signer", credentialId: Buffer.alloc(16, 1), publicKey: Buffer.alloc(65, 4) }),
  validateWalletDeploy: () => ({ deployer: "G", salt: Buffer.alloc(32), credentialId: Buffer.alloc(16, 1), publicKey: Buffer.alloc(65, 4) }),
  deployerAddress: () => "G",
  deployedContractAddress: () => StrKey.encodeContract(Buffer.alloc(32, 9)),
}));

vi.mock("@/lib/stellar/channels", () => ({
  simulateWithinCap: async () => {},
  submitAndConfirm: async () => ({ transactionId: "t1", hash: "ab".repeat(32), status: "confirmed" }),
}));

vi.mock("@/lib/stellar/direct-submit", () => ({
  submitPaidWrite: async () => ({ hash: "ab".repeat(32), feeStroops: BigInt(51_000), status: state.paidStatus }),
}));

vi.mock("@/lib/market-server", () => ({
  marketCallPlan: async () => ({ transfers: [], sale: null }),
  purchaseColumns: () => ({}),
  syncTemplate: async () => {},
}));

vi.mock("@/lib/stellar/wallet-signers", () => ({ readWalletPasskeys: async () => [] }));

const { POST } = await import("./route");

/** The request, then everything it left for after the response, as the framework runs it. */
const respond = () => POST(new Request("https://doqtri.test/api/chain/relay", { method: "POST", body: "{}" }));
const finish = () => Promise.all(state.afterResponse.splice(0).map((callback) => callback()));
const post = async () => {
  const res = await respond();
  await finish();
  return res;
};
const recorded = () => state.rpcCalls.filter((c) => c.fn === "record_referral_activity").map((c) => c.args);
const activity = (fn: string) =>
  expect.objectContaining({
    p_user_id: "u1",
    p_network: "testnet",
    p_tx_hash: hash,
    p_wallet: wallet,
    p_fn: fn,
    p_threshold: 3,
    p_reward_php: 30,
    p_default_limit: 30,
  });

const note = { fn: "anchor", docId: "51000000-0000-4000-8000-000000000001", maxFee: BigInt(100_000), expirationLedger: 1 };
const membership = {
  fn: "add_editor",
  workspaceId: "7a000000-0000-4000-8000-0000000000b1",
  subject: StrKey.encodeContract(Buffer.alloc(32, 5)),
  maxFee: BigInt(100_000),
  expirationLedger: 1,
};
const tip = { fn: "tip", templateId: "cccccccccccccccc" };

beforeEach(() => {
  state.userPaysFees = false;
  state.target = CONTRACT_ID;
  state.forwardedTo = null;
  state.deploying = false;
  state.write = note;
  state.call = tip;
  state.paidStatus = "confirmed";
  state.recordFails = null;
  state.afterResponse = [];
  state.afterRefuses = false;
  state.rpcCalls = [];
  state.inserts = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/chain/relay and referral activity, sponsored writes", () => {
  it("relayRegistryWrite: records a confirmed note write", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([activity("anchor")]);
  });

  it("relayRegistryWrite: records a membership write, which chain_writes never holds", async () => {
    state.write = membership;
    const res = await post();
    expect(res.status).toBe(200);
    expect(state.inserts).toEqual([]);
    expect(recorded()).toEqual([activity("add_editor")]);
  });

  it("relayMarketWrite: records a market write", async () => {
    state.target = marketContract;
    const res = await post();
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([activity("tip")]);
  });
});

describe("POST /api/chain/relay and referral activity, paid writes", () => {
  beforeEach(() => {
    state.userPaysFees = true;
    state.target = forwarder;
  });

  it("relayPaidWrite: records a confirmed note write", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([activity("anchor")]);
  });

  it("relayPaidWrite: records a confirmed membership write", async () => {
    state.write = membership;
    const res = await post();
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([activity("add_editor")]);
  });

  it("relayPaidWrite: doesn't record a pending note write: it counts once it is settled", async () => {
    state.paidStatus = "pending";
    const res = await post();
    expect(res.status).toBe(202);
    expect(state.inserts).toEqual(["chain_writes"]);
    expect(recorded()).toEqual([]);
  });

  it("relayPaidWrite: doesn't record a pending membership write", async () => {
    state.write = membership;
    state.paidStatus = "pending";
    expect((await post()).status).toBe(502);
    expect(recorded()).toEqual([]);
  });

  it("relayPaidMarketWrite: records a confirmed market write", async () => {
    state.forwardedTo = marketContract;
    const res = await post();
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([activity("tip")]);
  });

  it("relayPaidMarketWrite: doesn't record a pending one", async () => {
    state.forwardedTo = marketContract;
    state.paidStatus = "pending";
    expect((await post()).status).toBe(502);
    expect(recorded()).toEqual([]);
  });
});

describe("POST /api/chain/relay and referral activity, what doesn't count", () => {
  it("a passkey change", async () => {
    state.target = wallet;
    const res = await post();
    expect(res.status).toBe(200);
    expect(state.inserts).toEqual(["wallet_passkeys"]);
    expect(recorded()).toEqual([]);
  });

  it("a wallet deployment", async () => {
    state.deploying = true;
    const res = await post();
    expect(res.status).toBe(200);
    expect(state.inserts).toEqual(["smart_wallets", "wallet_passkeys"]);
    expect(recorded()).toEqual([]);
  });
});

describe("POST /api/chain/relay when the activity can't be recorded (AC 10)", () => {
  const paths: { name: string; paid: boolean; target: () => string; forwardedTo: string | null }[] = [
    { name: "relayRegistryWrite", paid: false, target: () => CONTRACT_ID, forwardedTo: null },
    { name: "relayMarketWrite", paid: false, target: () => marketContract, forwardedTo: null },
    { name: "relayPaidWrite", paid: true, target: () => forwarder, forwardedTo: null },
    { name: "relayPaidMarketWrite", paid: true, target: () => forwarder, forwardedTo: marketContract },
  ];

  describe.each(paths)("$name", ({ paid, target, forwardedTo }) => {
    beforeEach(() => {
      state.userPaysFees = paid;
      state.target = target();
      state.forwardedTo = forwardedTo;
    });

    it("answers before recording anything", async () => {
      const res = await respond();
      expect(res.status).toBe(200);
      expect(recorded()).toEqual([]);
      expect(state.afterResponse).toHaveLength(1);
      await finish();
      expect(recorded()).toHaveLength(1);
    });

    it("isn't held up by a recording that hangs on the referrer lock", async () => {
      state.recordFails = "hangs";
      const res = await respond();
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
      void state.afterResponse[0]();
      expect(recorded()).toHaveLength(1);
    });

    it.each(["refused", "throws"] as const)("gives the same answer when the record %s, and the callback rejects nothing", async (failure) => {
      const goodBody = await (await post()).json();

      state.recordFails = failure;
      state.rpcCalls = [];
      const res = await respond();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(goodBody);
      await expect(finish()).resolves.toBeDefined();
      expect(recorded()).toHaveLength(1);
    });

    it("gives the same answer when after() itself refuses", async () => {
      const goodBody = await (await post()).json();

      state.afterRefuses = true;
      state.rpcCalls = [];
      const res = await respond();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(goodBody);
      expect(recorded()).toEqual([]);
    });
  });
});
