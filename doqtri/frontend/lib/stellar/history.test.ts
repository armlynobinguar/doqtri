import { describe, expect, it } from "vitest";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { buildHistory, decodeInvocation, type HorizonOperation } from "@/lib/stellar/history";

const CONTRACT = "CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB";
const OTHER_CONTRACT = "CCP5KFIWLUNPV2G7ATBKFMIZF54JYRC343P5JCTARC4PRTGM23IU6ET4";
const OWNER = Keypair.random().publicKey();
const DOC = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

const b64 = (v: xdr.ScVal) => v.toXDR("base64");
const hashOf = (byte: number) => Buffer.alloc(32, byte);

/** A Horizon invoke_host_function record, shaped like the real API's. */
function op(
  fn: string,
  args: xdr.ScVal[],
  {
    contract = CONTRACT,
    tx = `${fn}-${Math.random().toString(16).slice(2)}`,
    ok = true,
  }: { contract?: string; tx?: string; ok?: boolean } = {},
): HorizonOperation {
  return {
    type: "invoke_host_function",
    transaction_successful: ok,
    transaction_hash: tx,
    created_at: "2026-09-28T00:00:00Z",
    parameters: [
      { type: "Address", value: b64(new Address(contract).toScVal()) },
      { type: "Sym", value: b64(xdr.ScVal.scvSymbol(fn)) },
      ...args.map((a) => ({ type: "Unknown", value: b64(a) })),
    ],
  };
}

const str = (s: string) => nativeToScVal(s, { type: "string" });
const bytes = (b: Buffer) => xdr.ScVal.scvBytes(b);
const status = (tag: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(tag)]);

const register = (doc = DOC, byte = 1, opts = {}) =>
  op("register_document", [new Address(OWNER).toScVal(), str(doc), bytes(hashOf(byte))], opts);
const update = (doc = DOC, byte = 2, opts = {}) =>
  op("update_document", [str(doc), bytes(hashOf(byte))], opts);
const node = (id: string, tag: string, opts = {}) =>
  op("set_node_status", [str(DOC), str(id), status(tag), str("n8n"), str("wf_1")], opts);

describe("decodeInvocation", () => {
  it("decodes each registry call", () => {
    expect(decodeInvocation(register(), CONTRACT)).toEqual({
      fn: "register_document",
      docId: DOC,
      hash: hashOf(1).toString("hex"),
    });
    expect(decodeInvocation(update(), CONTRACT)).toEqual({
      fn: "update_document",
      docId: DOC,
      hash: hashOf(2).toString("hex"),
    });
    expect(decodeInvocation(node("h0", "Built"), CONTRACT)).toEqual({
      fn: "set_node_status",
      docId: DOC,
      nodeId: "h0",
      status: "Built",
      tool: "n8n",
      artifactRef: "wf_1",
    });
  });

  it("ignores other contracts, failed transactions, and other operation types", () => {
    expect(decodeInvocation(register(DOC, 1, { contract: OTHER_CONTRACT }), CONTRACT)).toBeNull();
    expect(decodeInvocation(register(DOC, 1, { ok: false }), CONTRACT)).toBeNull();
    expect(
      decodeInvocation(
        { type: "payment", transaction_hash: "x", created_at: "" },
        CONTRACT,
      ),
    ).toBeNull();
    expect(
      decodeInvocation(
        {
          type: "invoke_host_function",
          transaction_hash: "x",
          created_at: "",
          parameters: [{ type: "Address", value: "not-xdr" }, { type: "Sym", value: "??" }],
        },
        CONTRACT,
      ),
    ).toBeNull();
  });
});

describe("buildHistory", () => {
  it("numbers versions by order and tags node events with the version in effect", () => {
    const ops = [
      register(DOC, 1, { tx: "t1" }),
      node("h0", "Building", { tx: "t2" }),
      update(DOC, 2, { tx: "t3" }),
      node("h1", "Planned", { tx: "t4" }),
      node("h0", "Built", { tx: "t5" }),
      update("some-other-doc", 9, { tx: "t6" }),
      update(DOC, 3, { tx: "t7", ok: false }),
    ];

    const history = buildHistory(ops, DOC, CONTRACT, OWNER);

    expect(history.versions.map((v) => [v.version, v.txHash, v.contentHash])).toEqual([
      [1, "t1", hashOf(1).toString("hex")],
      [2, "t3", hashOf(2).toString("hex")],
    ]);
    expect(history.nodeEvents.map((e) => [e.nodeId, e.status, e.docVersion])).toEqual([
      ["h0", "Building", 1],
      ["h1", "Planned", 2],
      ["h0", "Built", 2],
    ]);
    // Latest per node, kept in first-seen order.
    expect(history.nodes.map((n) => [n.nodeId, n.status, n.txHash])).toEqual([
      ["h0", "Built", "t5"],
      ["h1", "Planned", "t4"],
    ]);
  });
});
