import { describe, expect, it } from "vitest";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import {
  buildHistory,
  decodeInvocation,
  inLedgerOrder,
  mergeOperations,
  withCompleteness,
  type HorizonOperation,
} from "@/lib/stellar/history";

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
/** anchor(owner, doc_id, content_hash, nodes), nodes as the SDK encodes NodeUpdate structs. */
const anchorOp = (byte: number, nodes: [string, string][] = [], opts = {}) =>
  op(
    "anchor",
    [
      new Address(OWNER).toScVal(),
      str(DOC),
      bytes(hashOf(byte)),
      xdr.ScVal.scvVec(
        nodes.map(([id, tag]) =>
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("artifact_ref"), val: str("v1") }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("node_id"), val: str(id) }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("status"), val: status(tag) }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("tool"), val: str("doqtri-done") }),
          ]),
        ),
      ),
    ],
    opts,
  );

describe("anchor (registry v2)", () => {
  it("decodes an anchor call with its node updates", () => {
    expect(decodeInvocation(anchorOp(1, [["root", "Verified"]]), CONTRACT)).toEqual({
      fn: "anchor",
      docId: DOC,
      hash: hashOf(1).toString("hex"),
      nodes: [{ nodeId: "root", status: "Verified", tool: "doqtri-done", artifactRef: "v1" }],
    });
  });

  it("numbers versions like the contract: new text is a version, the same text is not", () => {
    const history = buildHistory(
      [anchorOp(1, [["root", "Built"]]), anchorOp(1, [["root", "Verified"]]), anchorOp(2)],
      DOC,
      CONTRACT,
      OWNER,
    );
    expect(history.versions.map((v) => [v.version, v.contentHash])).toEqual([
      [1, hashOf(1).toString("hex")],
      [2, hashOf(2).toString("hex")],
    ]);
    expect(history.nodes).toEqual([expect.objectContaining({ nodeId: "root", status: "Verified", docVersion: 1 })]);
  });

  it("continues a migrated document's history from the registry it came from", () => {
    const ops = [
      register(DOC, 1, { contract: OTHER_CONTRACT }),
      update(DOC, 2, { contract: OTHER_CONTRACT }),
      anchorOp(3, [["root", "Verified"]]),
    ];
    const history = buildHistory(ops, DOC, [CONTRACT, OTHER_CONTRACT], OWNER);
    expect(history.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(history.nodes[0]).toEqual(expect.objectContaining({ nodeId: "root", docVersion: 3 }));
    // Without the old registry, only the new write counts.
    expect(buildHistory(ops, DOC, CONTRACT, OWNER).versions).toHaveLength(1);
  });
});

describe("the *_as writes (registry v3)", () => {
  const SIGNER = Keypair.random().publicKey();
  const signer = new Address(SIGNER).toScVal();
  const nodeUpdate = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("artifact_ref"), val: str("v1") }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("node_id"), val: str("root") }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("status"), val: status("Built") }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("tool"), val: str("doqtri-done") }),
  ]);

  it("decodes them as the writes they stand for, skipping the signer", () => {
    expect(decodeInvocation(op("anchor_as", [signer, str(DOC), bytes(hashOf(1)), xdr.ScVal.scvVec([nodeUpdate])]), CONTRACT)).toEqual({
      fn: "anchor",
      docId: DOC,
      hash: hashOf(1).toString("hex"),
      nodes: [{ nodeId: "root", status: "Built", tool: "doqtri-done", artifactRef: "v1" }],
    });
    expect(decodeInvocation(op("update_document_as", [signer, str(DOC), bytes(hashOf(2))]), CONTRACT)).toEqual({
      fn: "update_document",
      docId: DOC,
      hash: hashOf(2).toString("hex"),
    });
    expect(
      decodeInvocation(op("set_node_status_as", [signer, str(DOC), str("h1"), status("Verified"), str("gh"), str("pr#2")]), CONTRACT),
    ).toEqual({ fn: "set_node_status", docId: DOC, nodeId: "h1", status: "Verified", tool: "gh", artifactRef: "pr#2" });
  });

  it("numbers versions across owner-only and *_as writes", () => {
    const ops = [
      anchorOp(1),
      op("update_document_as", [signer, str(DOC), bytes(hashOf(2))]),
      op("anchor_as", [signer, str(DOC), bytes(hashOf(2)), xdr.ScVal.scvVec([nodeUpdate])]),
      // Assigning moves no version.
      op("assign_document", [str(DOC), str("7a000000-0000-4000-8000-0000000000d1")]),
    ];
    const history = buildHistory(ops, DOC, CONTRACT, OWNER);
    expect(history.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(history.nodes).toEqual([expect.objectContaining({ nodeId: "root", status: "Built", docVersion: 2 })]);
  });
});

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

describe("passkey-wallet history (from the write index)", () => {
  const token = (op: HorizonOperation, t: string): HorizonOperation => ({ ...op, paging_token: t });

  it("restores ledger order across separately fetched transactions", () => {
    // Fetched per transaction, so they can arrive in any order.
    const shuffled = [
      token(update(DOC, 2, { tx: "t3" }), "300"),
      token(register(DOC, 1, { tx: "t1" }), "100"),
      token(node("h0", "Built", { tx: "t2" }), "200"),
    ];
    const history = buildHistory(inLedgerOrder(shuffled), DOC, CONTRACT, OWNER);
    expect(history.versions.map((v) => [v.version, v.txHash])).toEqual([
      [1, "t1"],
      [2, "t3"],
    ]);
    expect(history.nodeEvents[0].docVersion).toBe(1);
  });

  it("orders by paging token numerically, not as text", () => {
    const ops = [token(register(DOC, 1, { tx: "late" }), "1000"), token(register(DOC, 1, { tx: "early" }), "999")];
    expect(inLedgerOrder(ops).map((op) => op.transaction_hash)).toEqual(["early", "late"]);
  });

  it("ignores indexed transactions that are not this document on this contract", () => {
    // A bogus or mistaken index row can point anywhere; the decoder only keeps
    // successful calls to the registry for this document.
    const ops = inLedgerOrder([
      token(register(DOC, 1, { tx: "real" }), "1"),
      token(update("someone-elses-doc", 2, { tx: "other-doc" }), "2"),
      token(update(DOC, 2, { tx: "failed", ok: false }), "3"),
    ]);
    expect(buildHistory(ops, DOC, CONTRACT, OWNER).versions.map((v) => v.txHash)).toEqual(["real"]);
  });

  it("flags a history with fewer versions than the contract reports", () => {
    const history = buildHistory([register(DOC, 1, { tx: "t1" })], DOC, CONTRACT, OWNER);
    expect(withCompleteness(history, 1).incomplete).toBeUndefined();
    expect(withCompleteness(history, 3).incomplete).toBe(true);
  });
});

describe("user-paid writes (wrapped in the fee forwarder)", () => {
  const FORWARDER = "CCBBXJSS7DUT34QDJOMZLAYMYOT4Q73NUSY573G4STXFUBSYXDKUBUHV";
  const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const WALLET = "CCNDHVHSKXUYRXOKJI4PFBCZFGZRL4X4ZYLHVJCU3CI63G63UJGZZITE";
  const forward = (target: string, fn: string, args: xdr.ScVal[], opts = {}) =>
    op(
      "forward",
      [
        new Address(XLM).toScVal(),
        nativeToScVal(BigInt(600000), { type: "i128" }),
        nativeToScVal(BigInt(5000000), { type: "i128" }),
        nativeToScVal(5000, { type: "u32" }),
        new Address(target).toScVal(),
        xdr.ScVal.scvSymbol(fn),
        xdr.ScVal.scvVec(args),
        new Address(WALLET).toScVal(),
        new Address(OWNER).toScVal(),
      ],
      { contract: FORWARDER, ...opts },
    );

  it("decodes the registry call inside forward", () => {
    const wrapped = forward(CONTRACT, "register_document", [new Address(WALLET).toScVal(), str(DOC), bytes(hashOf(7))]);
    expect(decodeInvocation(wrapped, CONTRACT, FORWARDER)).toEqual({
      fn: "register_document",
      docId: DOC,
      hash: hashOf(7).toString("hex"),
    });
  });

  it("ignores forwarded calls to other contracts, and forwarders it doesn't know", () => {
    const elsewhere = forward(OTHER_CONTRACT, "update_document", [str(DOC), bytes(hashOf(8))]);
    expect(decodeInvocation(elsewhere, CONTRACT, FORWARDER)).toBeNull();
    const wrapped = forward(CONTRACT, "update_document", [str(DOC), bytes(hashOf(8))]);
    expect(decodeInvocation(wrapped, CONTRACT, null)).toBeNull();
  });

  it("builds versions from a mix of direct and forwarded writes", () => {
    // Unit tests run on the testnet config, where this forwarder is configured.
    const history = buildHistory(
      [register(DOC, 1, { tx: "direct" }), forward(CONTRACT, "update_document", [str(DOC), bytes(hashOf(2))], { tx: "paid" })],
      DOC,
      CONTRACT,
      OWNER,
    );
    expect(history.versions.map((v) => [v.version, v.txHash])).toEqual([
      [1, "direct"],
      [2, "paid"],
    ]);
  });
});

describe("workspace-note history (owner feed and write index together)", () => {
  const token = (op: HorizonOperation, t: string): HorizonOperation => ({ ...op, paging_token: t });

  it("keeps an editor's indexed passkey write that the owner's feed lacks, and counts a shared write once", () => {
    const registered = token(register(DOC, 1, { tx: "owner-register" }), "100");
    const ownerFeed = [registered, token(update(DOC, 3, { tx: "owner-update" }), "300")];
    // The editor's update_document_as was relayed and indexed; the index can also list the owner's own write.
    const editorWrite = token(op("update_document_as", [new Address(OWNER).toScVal(), str(DOC), bytes(hashOf(2))], { tx: "editor-update" }), "200");
    const indexed = [editorWrite, registered];

    const history = withCompleteness(buildHistory(mergeOperations(ownerFeed, indexed), DOC, CONTRACT, OWNER), 3);
    expect(history.versions.map((v) => [v.version, v.txHash])).toEqual([
      [1, "owner-register"],
      [2, "editor-update"],
      [3, "owner-update"],
    ]);
    expect(history.incomplete).toBeUndefined();
  });

  it("marks the history incomplete when a write is in neither source", () => {
    const ownerFeed = [token(register(DOC, 1, { tx: "owner-register" }), "100")];
    const history = withCompleteness(buildHistory(mergeOperations(ownerFeed, []), DOC, CONTRACT, OWNER), 2);
    expect(history.incomplete).toBe(true);
  });
});
