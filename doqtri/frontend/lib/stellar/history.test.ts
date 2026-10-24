import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import {
  buildHistory,
  decodeInvocation,
  fetchAccountOperationsSince,
  inLedgerOrder,
  mergeOperations,
  ownWritesOnly,
  ownerAuthorizer,
  scanRegistryEvents,
  signedWriteTransactions,
  withCompleteness,
  type EventSource,
  type HorizonOperation,
  type RegistryEvent,
} from "@/lib/stellar/history";
import { HORIZON_URL } from "@/lib/stellar/config";

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
      signer: OWNER,
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

  it("decodes them as the writes they stand for, with their signer", () => {
    expect(decodeInvocation(op("anchor_as", [signer, str(DOC), bytes(hashOf(1)), xdr.ScVal.scvVec([nodeUpdate])]), CONTRACT)).toEqual({
      fn: "anchor",
      docId: DOC,
      hash: hashOf(1).toString("hex"),
      nodes: [{ nodeId: "root", status: "Built", tool: "doqtri-done", artifactRef: "v1" }],
      signer: SIGNER,
    });
    expect(decodeInvocation(op("update_document_as", [signer, str(DOC), bytes(hashOf(2))]), CONTRACT)).toEqual({
      fn: "update_document",
      docId: DOC,
      hash: hashOf(2).toString("hex"),
      signer: SIGNER,
    });
    expect(
      decodeInvocation(op("set_node_status_as", [signer, str(DOC), str("h1"), status("Verified"), str("gh"), str("pr#2")]), CONTRACT),
    ).toEqual({ fn: "set_node_status", docId: DOC, nodeId: "h1", status: "Verified", tool: "gh", artifactRef: "pr#2", signer: SIGNER });
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
      signer: OWNER,
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
      signer: WALLET,
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

describe("signers (WP-1.8)", () => {
  const EDITOR = Keypair.random().publicKey();
  const PASSKEY = "CCNDHVHSKXUYRXOKJI4PFBCZFGZRL4X4ZYLHVJCU3CI63G63UJGZZITE";
  const as = (who: string) => new Address(who).toScVal();
  const token = (op: HorizonOperation, t: string): HorizonOperation => ({ ...op, paging_token: t });

  it("names the signer a call carries, and the owner for owner-only calls", () => {
    const ops = [
      token(register(DOC, 1, { tx: "reg" }), "1"),
      token(update(DOC, 2, { tx: "upd" }), "2"),
      token(op("update_document_as", [as(EDITOR), str(DOC), bytes(hashOf(3))], { tx: "ed" }), "3"),
      token(op("update_document_as", [as(PASSKEY), str(DOC), bytes(hashOf(4))], { tx: "pk" }), "4"),
    ];
    // Test ops carry no transaction, so owner-only writes fall back to the owner (REGISTRY_EDITORS off).
    const history = buildHistory(ops, DOC, CONTRACT, OWNER, { fixedOwner: true });
    expect(history.versions.map((v) => [v.txHash, v.signer, v.signerFrom])).toEqual([
      ["reg", OWNER, "call"],
      ["upd", OWNER, "owner"],
      ["ed", EDITOR, "call"],
      ["pk", PASSKEY, "call"],
    ]);
  });

  it("names the signer of each node status, from set_node_status_as and anchor_as alike", () => {
    const nodeUpdate = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("artifact_ref"), val: str("v1") }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("node_id"), val: str("root") }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("status"), val: status("Built") }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("tool"), val: str("doqtri-done") }),
    ]);
    const ops = [
      anchorOp(1, [["h0", "Planned"]]),
      op("set_node_status_as", [as(EDITOR), str(DOC), str("h0"), status("Building"), str("gh"), str("pr#1")]),
      node("h1", "Planned"),
      op("anchor_as", [as(PASSKEY), str(DOC), bytes(hashOf(1)), xdr.ScVal.scvVec([nodeUpdate])]),
    ];
    const history = buildHistory(ops, DOC, CONTRACT, OWNER, { fixedOwner: true });
    expect(history.nodeEvents.map((e) => [e.nodeId, e.status, e.signer, e.signerFrom])).toEqual([
      ["h0", "Planned", OWNER, "call"],
      ["h0", "Building", EDITOR, "call"],
      ["h1", "Planned", OWNER, "owner"],
      ["root", "Built", PASSKEY, "call"],
    ]);
    // anchor_as with unchanged text is no new version, so its signer is on the node only.
    expect(history.versions.map((v) => v.signer)).toEqual([OWNER]);
  });

  it("names the wallet a forwarded (user-paid) write was signed by", () => {
    const FORWARDER = "CCBBXJSS7DUT34QDJOMZLAYMYOT4Q73NUSY573G4STXFUBSYXDKUBUHV";
    const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const forwarded = op(
      "forward",
      [
        new Address(XLM).toScVal(),
        nativeToScVal(BigInt(600000), { type: "i128" }),
        nativeToScVal(BigInt(5000000), { type: "i128" }),
        nativeToScVal(5000, { type: "u32" }),
        new Address(CONTRACT).toScVal(),
        xdr.ScVal.scvSymbol("update_document_as"),
        xdr.ScVal.scvVec([as(PASSKEY), str(DOC), bytes(hashOf(5))]),
        new Address(PASSKEY).toScVal(),
        new Address(OWNER).toScVal(),
      ],
      { contract: FORWARDER },
    );
    expect(decodeInvocation(forwarded, CONTRACT, FORWARDER)).toEqual(expect.objectContaining({ signer: PASSKEY }));
  });

  describe("signedWriteTransactions (the *_as events)", () => {
    const sym = (s: string) => xdr.ScVal.scvSymbol(s);
    const event = (topic: xdr.ScVal[], value: xdr.ScVal, txHash: string, ok = true): RegistryEvent => ({
      topic,
      value,
      txHash,
      inSuccessfulContractCall: ok,
    });

    it("keeps this note's *_as writes with the signer from their topic", () => {
      const events = [
        event([sym("doqtri"), sym("update"), as(EDITOR)], str(DOC), "a"),
        event([sym("doqtri"), sym("node"), as(EDITOR)], str(DOC), "a"),
        event([sym("doqtri"), sym("node"), as(PASSKEY)], str(DOC), "b"),
      ];
      expect(signedWriteTransactions(events, DOC)).toEqual([
        { txHash: "a", signer: EDITOR },
        { txHash: "b", signer: PASSKEY },
      ]);
    });

    it("skips other notes, owner-only events, membership events and failed calls", () => {
      const events = [
        event([sym("doqtri"), sym("update"), as(EDITOR)], str("another-doc"), "other"),
        event([sym("doqtri"), sym("update")], str(DOC), "owner-only"),
        event(
          [sym("doqtri_ws"), sym("edit_rm"), as(EDITOR)],
          xdr.ScVal.scvVec([str("ws"), as(EDITOR), as(OWNER)]),
          "membership",
        ),
        event([sym("doqtri"), sym("update"), as(EDITOR)], str(DOC), "failed", false),
        event([sym("doqtri"), sym("update"), str("not-an-address")], str(DOC), "garbled"),
      ];
      expect(signedWriteTransactions(events, DOC)).toEqual([]);
    });
  });

  it("finds a removed editor's Freighter write in their own feed, and counts it once", () => {
    // The owner's feed and the index miss an editor's Freighter write; the
    // events and the removed signer's feed both carry it.
    const ownerFeed = [token(register(DOC, 1, { tx: "reg" }), "100")];
    const late = token(op("update_document_as", [as(EDITOR), str(DOC), bytes(hashOf(2))], { tx: "late" }), "200");
    const history = withCompleteness(
      buildHistory(mergeOperations(ownerFeed, [], [late], [late]), DOC, CONTRACT, OWNER),
      2,
    );
    expect(history.incomplete).toBeUndefined();
    expect(history.versions.map((v) => [v.version, v.txHash, v.signer])).toEqual([
      [1, "reg", OWNER],
      [2, "late", EDITOR],
    ]);
  });
});

describe("review fixes (WP-1.8)", () => {
  const REMOVED = Keypair.random().publicKey();
  const NEW_OWNER = Keypair.random().publicKey();
  const as = (who: string) => new Address(who).toScVal();
  const token = (o: HorizonOperation, t: string): HorizonOperation => ({ ...o, paging_token: t });

  describe("a removed signer's feed and the events only add that signer's own writes", () => {
    // The legacy registry still accepts writes for a doc id it never held:
    // anyone can register it there and then make owner-only calls.
    const forgedRegister = token(
      op("register_document", [as(REMOVED), str(DOC), bytes(hashOf(9))], { contract: OTHER_CONTRACT, tx: "forged-reg" }),
      "210",
    );
    const forgedUpdate = token(update(DOC, 9, { contract: OTHER_CONTRACT, tx: "forged-update" }), "220");
    const forgedStatus = token(node("h0", "Built", { contract: OTHER_CONTRACT, tx: "forged-status" }), "230");
    const forgedAsOnLegacy = token(
      op("update_document_as", [as(REMOVED), str(DOC), bytes(hashOf(8))], { contract: OTHER_CONTRACT, tx: "legacy-as" }),
      "240",
    );
    const ownLate = token(op("update_document_as", [as(REMOVED), str(DOC), bytes(hashOf(2))], { tx: "own-late" }), "250");
    const someoneElses = token(
      op("update_document_as", [as(NEW_OWNER), str(DOC), bytes(hashOf(3))], { tx: "not-theirs" }),
      "260",
    );
    const feed = [forgedRegister, forgedUpdate, forgedStatus, forgedAsOnLegacy, ownLate, someoneElses];

    it("keeps only the feed owner's own named writes on the current registry", () => {
      expect(ownWritesOnly(feed, DOC, () => REMOVED, CONTRACT).map((o) => o.transaction_hash)).toEqual(["own-late"]);
    });

    it("so a legacy-registry update or status never shows as the owner's", () => {
      const ownerFeed = [token(register(DOC, 1, { tx: "reg" }), "100")];
      const removedFeed = ownWritesOnly(feed, DOC, () => REMOVED, CONTRACT);
      const history = buildHistory(mergeOperations(ownerFeed, removedFeed), DOC, [CONTRACT, OTHER_CONTRACT], OWNER, {
        fixedOwner: true,
      });
      expect(history.versions.map((v) => [v.txHash, v.signer])).toEqual([
        ["reg", OWNER],
        ["own-late", REMOVED],
      ]);
      expect(history.nodeEvents).toEqual([]);
      // Unfiltered, the forged writes would have been credited to the owner.
      const unfiltered = buildHistory(mergeOperations(ownerFeed, feed), DOC, [CONTRACT, OTHER_CONTRACT], OWNER, {
        fixedOwner: true,
      });
      expect(unfiltered.nodeEvents.map((e) => [e.txHash, e.signer])).toEqual([["forged-status", OWNER]]);
    });

    it("keeps an event's transaction only for the signer the event named", () => {
      const signerOf = new Map([
        ["own-late", REMOVED],
        ["not-theirs", REMOVED],
      ]);
      expect(
        ownWritesOnly([ownLate, someoneElses], DOC, (o) => signerOf.get(o.transaction_hash), CONTRACT).map(
          (o) => o.transaction_hash,
        ),
      ).toEqual(["own-late"]);
    });
  });

  describe("owner-only writes are credited to whoever owned the note then", () => {
    const invocation = (contract: string, fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
      new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args }),
        ),
        subInvocations: subs,
      });
    const byAddress = (who: string, root: xdr.SorobanAuthorizedInvocation) =>
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: new Address(who).toScAddress(),
            nonce: xdr.Int64.fromString("7"),
            signatureExpirationLedger: 100,
            signature: xdr.ScVal.scvVoid(),
          }),
        ),
        rootInvocation: root,
      });
    const bySource = (root: xdr.SorobanAuthorizedInvocation) =>
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: root,
      });
    /** An owner-only write as Horizon returns it with join=transactions. */
    const withTx = (
      base: HorizonOperation,
      { source, contract = CONTRACT, fn, args, auth }: {
        source: string;
        contract?: string;
        fn: string;
        args: xdr.ScVal[];
        auth: xdr.SorobanAuthorizationEntry[];
      },
    ): HorizonOperation => {
      const tx = new TransactionBuilder(new Account(source, "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.invokeContractFunction({ contract, function: fn, args, auth }))
        .setTimeout(0)
        .build();
      return { ...base, source_account: source, transaction: { envelope_xdr: tx.toEnvelope().toXDR("base64") } };
    };
    const updateArgs = (byte: number) => [str(DOC), bytes(hashOf(byte))];
    const PASSKEY_OWNER = "CCNDHVHSKXUYRXOKJI4PFBCZFGZRL4X4ZYLHVJCU3CI63G63UJGZZITE";
    const RELAYER = Keypair.random().publicKey();

    it("names each write's own signer across a workspace transfer, not the current owner", () => {
      // v2: the first owner's passkey write, relayed (address credentials).
      const before = withTx(token(update(DOC, 2, { tx: "before" }), "200"), {
        source: RELAYER,
        fn: "update_document",
        args: updateArgs(2),
        auth: [byAddress(PASSKEY_OWNER, invocation(CONTRACT, "update_document", updateArgs(2)))],
      });
      // transfer_workspace in between; v3: the new owner's own Freighter write.
      const after = withTx(token(update(DOC, 3, { tx: "after" }), "300"), {
        source: NEW_OWNER,
        fn: "update_document",
        args: updateArgs(3),
        auth: [bySource(invocation(CONTRACT, "update_document", updateArgs(3)))],
      });
      const history = buildHistory([token(register(DOC, 1, { tx: "reg" }), "100"), before, after], DOC, CONTRACT, NEW_OWNER);
      expect(history.versions.map((v) => [v.txHash, v.signer, v.signerFrom])).toEqual([
        ["reg", OWNER, "call"],
        ["before", PASSKEY_OWNER, "owner"],
        ["after", NEW_OWNER, "owner"],
      ]);
    });

    it("reads a forwarded write's signer from the sub-invocation", () => {
      const FORWARDER = "CCBBXJSS7DUT34QDJOMZLAYMYOT4Q73NUSY573G4STXFUBSYXDKUBUHV";
      const statusArgs = [str(DOC), str("h0"), status("Built"), str("n8n"), str("wf_1")];
      const forwarded = withTx(node("h0", "Built"), {
        source: RELAYER,
        contract: FORWARDER,
        fn: "forward",
        args: [],
        auth: [byAddress(PASSKEY_OWNER, invocation(FORWARDER, "forward", [], [invocation(CONTRACT, "set_node_status", statusArgs)]))],
      });
      expect(ownerAuthorizer(forwarded, "set_node_status", DOC, [CONTRACT])).toBe(PASSKEY_OWNER);
    });

    it("names nobody when the auth cannot be read, or names more than one wallet", () => {
      const ambiguous = withTx(update(DOC, 2), {
        source: RELAYER,
        fn: "update_document",
        args: updateArgs(2),
        auth: [
          byAddress(PASSKEY_OWNER, invocation(CONTRACT, "update_document", updateArgs(2))),
          byAddress(REMOVED, invocation(CONTRACT, "update_document", updateArgs(2))),
        ],
      });
      expect(ownerAuthorizer(ambiguous, "update_document", DOC, [CONTRACT])).toBeNull();
      const otherDoc = withTx(update(DOC, 2), {
        source: RELAYER,
        fn: "update_document",
        args: updateArgs(2),
        auth: [byAddress(PASSKEY_OWNER, invocation(CONTRACT, "update_document", [str("another-doc"), bytes(hashOf(2))]))],
      });
      expect(ownerAuthorizer(otherDoc, "update_document", DOC, [CONTRACT])).toBeNull();
      expect(ownerAuthorizer({ ...update(DOC, 2), transaction: { envelope_xdr: "garbage" } }, "update_document", DOC, [CONTRACT])).toBeNull();

      // Without the transaction: unnamed where ownership can move, the owner where it cannot.
      const bare = [token(update(DOC, 2, { tx: "bare" }), "1")];
      expect(buildHistory(bare, DOC, CONTRACT, OWNER).versions[0]).toEqual(
        expect.objectContaining({ signer: null, signerFrom: "owner" }),
      );
      expect(buildHistory(bare, DOC, CONTRACT, OWNER, { fixedOwner: true }).versions[0].signer).toBe(OWNER);
    });
  });

  describe("a removed signer's feed is read forward from the removal", () => {
    afterEach(() => vi.unstubAllGlobals());

    /** A Horizon with one ledger every 5 s and `account` making one operation per ledger after `first`. */
    function fakeHorizon(account: string, base: number, latest: number, ops: HorizonOperation[]) {
      const closedAt = (seq: number) => new Date(base + seq * 5000).toISOString();
      const requests: string[] = [];
      vi.stubGlobal("fetch", async (input: string) => {
        requests.push(input);
        const url = new URL(input);
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
        if (url.pathname === "/ledgers") {
          return json({ _embedded: { records: [{ sequence: latest, closed_at: closedAt(latest) }] } });
        }
        const ledger = url.pathname.match(/^\/ledgers\/(\d+)$/);
        if (ledger) return json({ sequence: Number(ledger[1]), closed_at: closedAt(Number(ledger[1])) });
        if (url.pathname === `/accounts/${account}/operations`) {
          expect(url.searchParams.get("order")).toBe("asc");
          const after = BigInt(url.searchParams.get("cursor") ?? "0");
          const page = ops.filter((o) => BigInt(o.paging_token!) > after).slice(0, 200);
          const next = page.length
            ? `${HORIZON_URL}/accounts/${account}/operations?order=asc&limit=200&cursor=${page[page.length - 1].paging_token}`
            : undefined;
          return json({ _embedded: { records: page }, _links: { next: { href: next } } });
        }
        return json({}, 404);
      });
      return { closedAt, requests };
    }

    it("finds the write right after a removal behind more than 1000 newer operations", async () => {
      const base = Date.parse("2026-10-01T00:00:00Z");
      const removedLedger = 10_000;
      const latest = 20_000;
      const opAt = (seq: number, o: HorizonOperation, closedAt: (s: number) => string): HorizonOperation => ({
        ...o,
        paging_token: (BigInt(seq) << BigInt(32)).toString(),
        created_at: closedAt(seq),
      });
      const closedAt = (seq: number) => new Date(base + seq * 5000).toISOString();
      const late = opAt(removedLedger + 1, op("update_document_as", [as(REMOVED), str(DOC), bytes(hashOf(2))], { tx: "late" }), closedAt);
      const noise = Array.from({ length: 1500 }, (_, i) =>
        opAt(removedLedger + 2 + i, { type: "payment", transaction_hash: `noise-${i}`, created_at: "" }, closedAt),
      );
      const earlier = Array.from({ length: 300 }, (_, i) =>
        opAt(removedLedger - 1000 + i, { type: "payment", transaction_hash: `before-${i}`, created_at: "" }, closedAt),
      );
      fakeHorizon(REMOVED, base, latest, [...earlier, late, ...noise]);

      const { ops, complete } = await fetchAccountOperationsSince(REMOVED, closedAt(removedLedger));
      expect(ops[0].transaction_hash).toBe("late");
      expect(ops.some((o) => o.transaction_hash.startsWith("before-"))).toBe(false);
      expect(complete).toBe(true);
      const kept = ownWritesOnly(ops, DOC, () => REMOVED, CONTRACT);
      expect(kept.map((o) => o.transaction_hash)).toEqual(["late"]);
    });

    it("stops at the restoration, and says when its page budget ran out first", async () => {
      const base = Date.parse("2026-10-01T00:00:00Z");
      const closedAt = (seq: number) => new Date(base + seq * 5000).toISOString();
      const opAt = (seq: number): HorizonOperation => ({
        type: "payment",
        transaction_hash: `op-${seq}`,
        created_at: closedAt(seq),
        paging_token: (BigInt(seq) << BigInt(32)).toString(),
      });
      const ops = Array.from({ length: 3000 }, (_, i) => opAt(1000 + i));
      fakeHorizon(REMOVED, base, 10_000, ops);

      const restored = await fetchAccountOperationsSince(REMOVED, closedAt(1000), closedAt(1100));
      expect(restored.complete).toBe(true);
      expect(restored.ops.map((o) => o.transaction_hash)).toEqual(ops.slice(0, 100).map((o) => o.transaction_hash));

      const busy = await fetchAccountOperationsSince(REMOVED, closedAt(1000));
      expect(busy.complete).toBe(false);
      expect(busy.ops[0].transaction_hash).toBe("op-1000");
    });
  });

  describe("the event scan reads the window newest first", () => {
    const sym = (s: string) => xdr.ScVal.scvSymbol(s);
    /** An RPC holding one event per ledger in [oldest, latest], paging `limit` at a time. */
    function fakeRpc(oldest: number, latest: number): EventSource & { calls: number } {
      const all = Array.from({ length: latest - oldest + 1 }, (_, i) => ({
        ledger: oldest + i,
        topic: [sym("doqtri"), sym("update"), new Address(REMOVED).toScVal()],
        value: str(DOC),
        txHash: `tx-${oldest + i}`,
        inSuccessfulContractCall: true,
      }));
      const cursorOf = (ledger: number) => `${(BigInt(ledger) << BigInt(32)).toString().padStart(19, "0")}-0000000000`;
      const server = {
        calls: 0,
        async getHealth() {
          return { oldestLedger: oldest, latestLedger: latest };
        },
        async getEvents(request: Parameters<EventSource["getEvents"]>[0]) {
          server.calls++;
          const limit = request.limit ?? 100;
          const from = "cursor" in request && request.cursor
            ? Number(BigInt(request.cursor.split("-")[0]) >> BigInt(32)) + 1
            : request.startLedger!;
          const until = "endLedger" in request && request.endLedger ? request.endLedger : latest + 1;
          const events = all.filter((e) => e.ledger >= from && e.ledger < until).slice(0, limit);
          const last = events.length ? events[events.length - 1].ledger : until - 1;
          return { events, cursor: cursorOf(last) };
        },
      };
      return server;
    }

    it("covers the whole window when the budget allows", async () => {
      const server = fakeRpc(1000, 1400);
      const { events, complete } = await scanRegistryEvents(server, [], { pageLimit: 50, maxPages: 40, slices: 4 });
      expect(complete).toBe(true);
      const ledgers = signedWriteTransactions(events, DOC).map((w) => Number(w.txHash.slice(3)));
      expect(new Set(ledgers).size).toBe(1400 - 1010 + 1);
      expect(Math.max(...ledgers)).toBe(1400);
    });

    it("keeps the newest events when the budget runs out, and says so", async () => {
      const server = fakeRpc(1000, 5000);
      const { events, complete } = await scanRegistryEvents(server, [], { pageLimit: 100, maxPages: 5, slices: 4 });
      expect(complete).toBe(false);
      expect(server.calls).toBe(5);
      const ledgers = events.map((e) => e.ledger);
      expect(Math.max(...ledgers)).toBe(5000);
      expect(Math.min(...ledgers)).toBeGreaterThan(3000);
    });
  });
});
