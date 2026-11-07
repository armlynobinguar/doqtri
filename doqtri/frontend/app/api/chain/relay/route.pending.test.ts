import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import type { PaidWriteResult } from "@/lib/stellar/direct-submit";

/*
 * A paid note write (progress/003) the network accepted but did not confirm
 * within the relay's poll window (DOQ-5): the route answers 202 and indexes
 * the write as pending for the chain-jobs run to settle. The shape checks,
 * the write's authorization and the submission itself are stood in; what is
 * checked is the answer and the chain_writes row.
 */

const wallet = StrKey.encodeContract(Buffer.alloc(32, 9));
const docId = "51000000-0000-4000-8000-000000000001";
const hash = "ab".repeat(32);

const noteWrite = { fn: "anchor", docId: "51000000-0000-4000-8000-000000000001", maxFee: BigInt(100_000), expirationLedger: 1 };

const state = vi.hoisted(() => ({
  submitted: null as unknown as PaidWriteResult,
  write: null as unknown as Record<string, unknown>,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
}));

// Outside a request, the real after() refuses; recording itself is route.referral.test.ts's.
vi.mock("next/server", () => ({ after: () => {} }));

vi.mock("@/lib/stellar/smart-wallet-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/smart-wallet-config")>()),
  FEE_FORWARDER: StrKey.encodeContract(Buffer.alloc(32, 7)),
  DOQTRI_RELAYER: "G" + "A".repeat(55),
  USER_PAYS_FEES: true,
  NETWORK: "testnet",
}));

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
    rpc: async () => ({ data: [{ allowed: true, scope: null }], error: null }),
  }),
}));

vi.mock("@/lib/stellar/relay-validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/relay-validation")>();
  return {
    ...actual,
    parseRelayBody: () => ({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(StrKey.encodeContract(Buffer.alloc(32, 7))).toScAddress(),
          functionName: "forward",
          args: [],
        }),
      ),
      auth: [],
    }),
    forwardedTarget: () => null,
    validateForwardedWrite: () => state.write,
    authorizeRegistryWrite: async () => {},
  };
});

vi.mock("@/lib/stellar/direct-submit", () => ({
  submitPaidWrite: async () => state.submitted,
}));

const { POST } = await import("./route");

const post = () => POST(new Request("https://doqtri.test/api/chain/relay", { method: "POST", body: "{}" }));

beforeEach(() => {
  state.inserts = [];
  state.write = noteWrite;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/chain/relay, a paid note write", () => {
  it("not confirmed within the poll window: answers 202 pending and indexes the write as pending", async () => {
    state.submitted = { hash, feeStroops: BigInt(51_000), status: "pending" };
    const res = await post();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: { hash, status: "pending", feeStroops: "51000" } });
    expect(state.inserts).toEqual([
      {
        table: "chain_writes",
        row: { network: "testnet", tx_hash: hash, document_id: docId, fn: "anchor", owner: wallet, status: "pending" },
      },
    ]);
  });

  it("confirmed: answers 200 and indexes the write as confirmed, as before", async () => {
    state.submitted = { hash, feeStroops: BigInt(51_000), status: "confirmed" };
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { hash, status: "confirmed", feeStroops: "51000" } });
    expect(state.inserts.map((i) => i.row.status)).toEqual(["confirmed"]);
  });
});

describe("POST /api/chain/relay, a paid membership write", () => {
  const addEditor = {
    fn: "add_editor",
    workspaceId: "7a000000-0000-4000-8000-0000000000b1",
    subject: StrKey.encodeContract(Buffer.alloc(32, 5)),
    maxFee: BigInt(100_000),
    expirationLedger: 1,
  };

  it("not confirmed within the poll window: still a 502 to check before retrying, since nothing settles it", async () => {
    state.write = addEditor;
    state.submitted = { hash, feeStroops: BigInt(51_000), status: "pending" };
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      success: false,
      error: "The network hasn't confirmed this transaction yet. Check again in a minute before retrying.",
    });
    expect(state.inserts).toEqual([]);
  });

  it("confirmed: answers 200, and is not indexed", async () => {
    state.write = addEditor;
    state.submitted = { hash, feeStroops: BigInt(51_000), status: "confirmed" };
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("confirmed");
    expect(state.inserts).toEqual([]);
  });
});
