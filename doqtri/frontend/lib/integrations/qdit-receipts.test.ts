import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRow } from "@/lib/integrations/qdit-approvals";
import { readMilestoneRecord, type SimulateCall } from "@/lib/integrations/qdit-chain";
import {
  createReadCache,
  loadQditReceipts,
  qditExplorerUrl,
  type ReceiptDeps,
} from "@/lib/integrations/qdit-receipts";
import type { ChainNode } from "@/lib/stellar/contract-client";
import type { ChainNodeEvent, DocumentHistory } from "@/lib/stellar/history";

/*
 * The public receipts' loader (WP-3.1). milestone_proof answers with the
 * exact ScVal XDR qdit's contract (integration/suite) returns from
 * get_milestone_status in the Soroban test host (G2 fixtures), decoded by
 * doqtri's own readMilestoneRecord; the registry and the approval store are
 * fakes.
 */

const RECORDS = {
  not_found_error: "Error(Contract, #3)",
  m1_submitted_v1:
    "AAAAEQAAAAEAAAAHAAAADwAAAAxtaWxlc3RvbmVfaWQAAAAOAAAAJGI4MWU0ZjA3LTZhMmMtNGQ5My04ZTVmLTBjN2E5YjNkMmU2MQAAAA8AAAAKcHJvamVjdF9pZAAAAAAADgAAACQzZjZjMmExZS04YjRkLTRjN2UtOWExMC0yZDViN2U5ZjFjMzQAAAAPAAAACnByb29mX2hhc2gAAAAAAA0AAAAgq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6sAAAAPAAAABnN0YXR1cwAAAAAAEAAAAAEAAAABAAAADwAAAAlTdWJtaXR0ZWQAAAAAAAAPAAAACXN1Ym1pdHRlcgAAAAAAABIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAPAAAACXRpbWVzdGFtcAAAAAAAAAUAAAAAAAAAAAAAAA8AAAAHdmVyc2lvbgAAAAADAAAAAQ==",
  m1_approved_v1:
    "AAAAEQAAAAEAAAAHAAAADwAAAAxtaWxlc3RvbmVfaWQAAAAOAAAAJGI4MWU0ZjA3LTZhMmMtNGQ5My04ZTVmLTBjN2E5YjNkMmU2MQAAAA8AAAAKcHJvamVjdF9pZAAAAAAADgAAACQzZjZjMmExZS04YjRkLTRjN2UtOWExMC0yZDViN2U5ZjFjMzQAAAAPAAAACnByb29mX2hhc2gAAAAAAA0AAAAgq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6sAAAAPAAAABnN0YXR1cwAAAAAAEAAAAAEAAAABAAAADwAAAAhBcHByb3ZlZAAAAA8AAAAJc3VibWl0dGVyAAAAAAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAA8AAAAJdGltZXN0YW1wAAAAAAAABQAAAAAAAAAAAAAADwAAAAd2ZXJzaW9uAAAAAAMAAAAB",
  m2_approved_v2:
    "AAAAEQAAAAEAAAAHAAAADwAAAAxtaWxlc3RvbmVfaWQAAAAOAAAAJGM5MmY1MDE4LTdiM2QtNGVhNC05ZjYwLTFkOGIwYzRlM2Y3MgAAAA8AAAAKcHJvamVjdF9pZAAAAAAADgAAACQzZjZjMmExZS04YjRkLTRjN2UtOWExMC0yZDViN2U5ZjFjMzQAAAAPAAAACnByb29mX2hhc2gAAAAAAA0AAAAgAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAAAAPAAAABnN0YXR1cwAAAAAAEAAAAAEAAAABAAAADwAAAAhBcHByb3ZlZAAAAA8AAAAJc3VibWl0dGVyAAAAAAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAA8AAAAJdGltZXN0YW1wAAAAAAAABQAAAAAAAAAAAAAADwAAAAd2ZXJzaW9uAAAAAAMAAAAC",
  m3_rejected_v1:
    "AAAAEQAAAAEAAAAHAAAADwAAAAxtaWxlc3RvbmVfaWQAAAAOAAAAJGQwYTM2MTI5LThjNGUtNGZiNS04YTcxLTJlOWMxZDVmNDA4MwAAAA8AAAAKcHJvamVjdF9pZAAAAAAADgAAACQzZjZjMmExZS04YjRkLTRjN2UtOWExMC0yZDViN2U5ZjFjMzQAAAAPAAAACnByb29mX2hhc2gAAAAAAA0AAAAgMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMAAAAPAAAABnN0YXR1cwAAAAAAEAAAAAEAAAABAAAADwAAAAhSZWplY3RlZAAAAA8AAAAJc3VibWl0dGVyAAAAAAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAA8AAAAJdGltZXN0YW1wAAAAAAAABQAAAAAAAAAAAAAADwAAAAd2ZXJzaW9uAAAAAAMAAAAB",
} as const;

const DOC = "30000000-0000-4000-8000-000000000001";
const PROJECT = "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34";
const M1 = "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61";
const M2 = "c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72";
const M3 = "d0a36129-8c4e-4fb5-8a71-2e9c1d5f4083";
const M4 = "e1b47230-9d5f-4ac6-9b82-3f0d2e6a5194";
const CONTRACT = "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG";
const SIGNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TX = (n: number) => n.toString(16).padStart(64, "0");
const APPROVAL_TX = "5e1f0c3a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d0f";

const ref = (milestone: string, version: number, network = "testnet") =>
  `qdit:${network}:${CONTRACT}:${PROJECT}/${milestone}@v${version}`;

function event(nodeId: string, status: string, artifactRef: string, n: number, tool = "qdit"): ChainNodeEvent {
  return {
    nodeId,
    status,
    tool,
    artifactRef,
    txHash: TX(n),
    closedAt: "2026-10-24T12:00:00Z",
    docVersion: 3,
    signer: SIGNER,
    signerFrom: "call",
  };
}

function history(events: ChainNodeEvent[]): DocumentHistory {
  const latest = new Map<string, ChainNodeEvent>();
  for (const e of events) latest.set(e.nodeId, e);
  return { owner: SIGNER, versions: [], nodeEvents: events, nodes: [...latest.values()] };
}

/** milestone_proof's answers, by milestone id: a record's XDR, or the contract's not-found error. */
let answers: Record<string, keyof typeof RECORDS>;
let simulate: ReturnType<typeof vi.fn<SimulateCall>>;
let nodes: Map<string, ChainNode | null | Error>;
let approvalRows: ApprovalRow[];

function deps(overrides: Partial<ReceiptDeps> = {}): ReceiptDeps {
  return {
    enabled: true,
    readNode: vi.fn(async (_doc: string, nodeId: string) => {
      const node = nodes.get(nodeId);
      if (node instanceof Error) throw node;
      return node ?? null;
    }),
    readMilestone: (chain, projectId, milestoneId) => readMilestoneRecord(chain, projectId, milestoneId, { simulate }),
    approvals: vi.fn(async () => approvalRows),
    cache: createReadCache(),
    ...overrides,
  };
}

const node = (e: ChainNodeEvent): ChainNode => ({ status: e.status, tool: e.tool, artifactRef: e.artifactRef, updatedAt: 1 });

beforeEach(() => {
  answers = { [M1]: "m1_approved_v1", [M2]: "m2_approved_v2", [M3]: "m3_rejected_v1" };
  simulate = vi.fn<SimulateCall>(async ({ args }) => {
    const milestone = String(scValToNative(args[1]));
    const answer = answers[milestone] ?? "not_found_error";
    if (answer === "not_found_error") return { ledger: 5000, error: `HostError: ${RECORDS.not_found_error}` };
    return { ledger: 5000, retval: xdr.ScVal.fromXDR(RECORDS[answer], "base64") };
  });
  nodes = new Map();
  approvalRows = [];
});

/** History whose latest records are also the contract's current ones. */
function setup(events: ChainNodeEvent[]) {
  const h = history(events);
  for (const n of h.nodes) nodes.set(n.nodeId, node(n));
  return h;
}

describe("loadQditReceipts: off", () => {
  it("reads nothing and returns null unless the integration is on", async () => {
    const d = deps({ enabled: false });
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    expect(await loadQditReceipts(DOC, h, d)).toBeNull();
    expect(d.readNode).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
    expect(d.approvals).not.toHaveBeenCalled();
  });

  it("defaults to NEXT_PUBLIC_QDIT_INTEGRATION", async () => {
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    expect(await loadQditReceipts(DOC, h, deps({ enabled: undefined }))).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
    expect(await loadQditReceipts(DOC, h, deps({ enabled: undefined }))).not.toBeNull();
    vi.unstubAllEnvs();
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it("returns null with no history, or no heading signed from qdit", async () => {
    const d = deps();
    expect(await loadQditReceipts(DOC, null, d)).toBeNull();
    const h = setup([event("h0", "Built", "github:acme/app#4", 1, "github"), event("h2", "Verified", "children:h3", 2, "rollup")]);
    expect(await loadQditReceipts(DOC, h, d)).toBeNull();
    expect(d.readNode).not.toHaveBeenCalled();
  });
});

describe("loadQditReceipts: states", () => {
  it("confirmed: a Verified record whose milestone is Approved at the ref's version", async () => {
    approvalRows = [
      { network: "testnet", contract_id: CONTRACT, project_id: PROJECT, milestone_id: M2, version: 2, tx_hash: APPROVAL_TX },
    ];
    const h = setup([event("h1", "Built", ref(M2, 2), 1), event("h1", "Verified", ref(M2, 2), 2)]);
    const d = deps();
    const result = await loadQditReceipts(DOC, h, d);
    expect(result?.more).toBe(0);
    expect(result?.receipts).toHaveLength(1);
    const [r] = result!.receipts;
    expect(r.check).toEqual({ state: "confirmed", chain: { status: "Approved", version: 2 }, ledger: 5000 });
    expect(r.record).toEqual({ status: "Verified", artifactRef: ref(M2, 2) });
    expect(r.ref).toMatchObject({ network: "testnet", contractId: CONTRACT, projectId: PROJECT, milestoneId: M2, version: 2 });
    // doqtri's own write that set this record, not the earlier Built one.
    expect(r.signing?.txHash).toBe(TX(2));
    expect(r.approvalTxHash).toBe(APPROVAL_TX);
    expect(d.approvals).toHaveBeenCalledWith([M2]);
    // The read went to the ref's own contract, for its own ids.
    const call = simulate.mock.calls[0][0];
    expect(call.contractId).toBe(CONTRACT);
    expect(call.method).toBe("get_milestone_status");
    expect(call.args.map((a) => scValToNative(a))).toEqual([PROJECT, M2]);
  });

  it("confirmed at a later version: approved again after a resubmission still backs the record", async () => {
    const h = setup([event("h1", "Verified", ref(M2, 1), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toMatchObject({ state: "confirmed", chain: { status: "Approved", version: 2 } });
  });

  it("confirmed for a status other than Verified when the chain backs it (Built and Submitted)", async () => {
    answers[M1] = "m1_submitted_v1";
    const h = setup([event("h1", "Built", ref(M1, 1), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toMatchObject({ state: "confirmed", chain: { status: "Submitted", version: 1 } });
    expect(r.approvalTxHash).toBeNull();
  });

  it("differs: a Verified record whose milestone the chain now holds as Submitted, Rejected, or not at all", async () => {
    answers[M1] = "m1_submitted_v1";
    const h = setup([
      event("h1", "Verified", ref(M1, 1), 1),
      event("h2", "Verified", ref(M3, 1), 2),
      event("h3", "Verified", ref(M4, 1), 3),
    ]);
    const d = deps();
    const result = (await loadQditReceipts(DOC, h, d))!;
    expect(result.receipts.map((r) => [r.nodeId, r.check])).toEqual([
      ["h1", { state: "differs", chain: { status: "Submitted", version: 1 }, ledger: 5000 }],
      ["h2", { state: "differs", chain: { status: "Rejected", version: 1 }, ledger: 5000 }],
      ["h3", { state: "differs", chain: null, ledger: 5000 }],
    ]);
    // Nothing is Approved, so no approval is looked for.
    expect(d.approvals).not.toHaveBeenCalled();
    expect(result.receipts.every((r) => r.approvalTxHash === null)).toBe(true);
  });

  it("differs: a Built record whose milestone has since been approved, with the approval shown", async () => {
    approvalRows = [
      { network: "testnet", contract_id: CONTRACT, project_id: PROJECT, milestone_id: M1, version: 1, tx_hash: APPROVAL_TX },
    ];
    const h = setup([event("h1", "Built", ref(M1, 1), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toMatchObject({ state: "differs", chain: { status: "Approved", version: 1 } });
    expect(r.approvalTxHash).toBe(APPROVAL_TX);
  });

  it("differs: the chain behind the ref's version is not taken as backing it", async () => {
    const h = setup([event("h1", "Verified", ref(M1, 2), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toMatchObject({ state: "differs", chain: { status: "Approved", version: 1 } });
  });

  it("only an approval of the version the chain holds, on the ref's own contract, is used", async () => {
    approvalRows = [
      { network: "testnet", contract_id: CONTRACT, project_id: PROJECT, milestone_id: M2, version: 1, tx_hash: TX(9) },
      { network: "mainnet", contract_id: CONTRACT, project_id: PROJECT, milestone_id: M2, version: 2, tx_hash: TX(8) },
      { network: "testnet", contract_id: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526", project_id: PROJECT, milestone_id: M2, version: 2, tx_hash: TX(7) },
    ];
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check.state).toBe("confirmed");
    expect(r.approvalTxHash).toBeNull();
  });

  it("unreachable: Stellar did not answer; the next view asks again", async () => {
    const cache = createReadCache();
    simulate.mockRejectedValueOnce(new Error("socket hang up"));
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps({ cache })))!.receipts;
    expect(r.check).toEqual({ state: "unreachable", reason: "rpc" });
    expect(r.signing?.txHash).toBe(TX(1));
    const [again] = (await loadQditReceipts(DOC, h, deps({ cache })))!.receipts;
    expect(again.check.state).toBe("confirmed");
  });

  it("unreachable: the named contract is not milestone_proof", async () => {
    simulate.mockResolvedValueOnce({ ledger: 5000, error: "HostError: Error(Storage, MissingValue)" });
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toEqual({ state: "unreachable", reason: "contract" });
  });

  it("unreachable: an artifact_ref that does not follow section 10 is never read", async () => {
    const bad = `qdit:testnet:${CONTRACT}:${PROJECT.toUpperCase()}/${M2}@v2`;
    const h = setup([event("h1", "Verified", bad, 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toEqual({ state: "unreachable", reason: "invalid_ref" });
    expect(r.ref).toBeNull();
    expect(simulate).not.toHaveBeenCalled();
  });
});

describe("loadQditReceipts: the current record", () => {
  it("uses the contract's record, not history's, and finds the write that set it", async () => {
    const h = history([event("h1", "Built", ref(M2, 2), 1)]);
    // History lags: the contract already holds a newer record, so no write in
    // the history read just now set it.
    nodes.set("h1", { status: "Verified", tool: "qdit", artifactRef: ref(M2, 2), updatedAt: 2 });
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.record.status).toBe("Verified");
    expect(r.check.state).toBe("confirmed");
    expect(r.signing).toBeNull();
  });

  it("drops a heading whose current record no longer names qdit", async () => {
    const h = history([event("h1", "Verified", ref(M2, 2), 1)]);
    nodes.set("h1", { status: "Built", tool: "github", artifactRef: "github:acme/app#4", updatedAt: 2 });
    expect(await loadQditReceipts(DOC, h, deps())).toBeNull();
    expect(simulate).not.toHaveBeenCalled();
  });

  it("falls back to history's latest write when the contract can't be asked", async () => {
    const h = history([event("h1", "Verified", ref(M2, 2), 1)]);
    nodes.set("h1", new Error("rpc down"));
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.record.status).toBe("Verified");
    expect(r.check.state).toBe("confirmed");
    expect(r.signing?.txHash).toBe(TX(1));
  });

  it("an approval store that fails only costs the approval link", async () => {
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps({ approvals: async () => Promise.reject(new Error("db down")) })))!.receipts;
    expect(r.check.state).toBe("confirmed");
    expect(r.approvalTxHash).toBeNull();
  });
});

describe("loadQditReceipts: bounded", () => {
  it("checks at most MAX_RECEIPTS headings and counts the rest", async () => {
    const events = Array.from({ length: 13 }, (_, i) => event(`h${i}`, "Verified", ref(M2, 2), i + 1));
    const h = setup(events);
    const d = deps();
    const result = (await loadQditReceipts(DOC, h, d))!;
    expect(result.receipts).toHaveLength(10);
    expect(result.more).toBe(3);
    expect(d.readNode).toHaveBeenCalledTimes(10);
    // Ten headings on one milestone: one read, shared through the cache.
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(d.approvals).toHaveBeenCalledTimes(1);
  });

  it("takes a smaller cap, and keeps the count when every checked heading dropped out", async () => {
    const h = history([event("h1", "Verified", ref(M2, 2), 1), event("h2", "Verified", ref(M1, 1), 2)]);
    nodes.set("h1", null);
    const result = (await loadQditReceipts(DOC, h, deps({ max: 1 })))!;
    expect(result).toEqual({ receipts: [], more: 1 });
  });

  it("caches a milestone's read for 30 seconds", async () => {
    let now = 0;
    const cache = createReadCache({ now: () => now });
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    await loadQditReceipts(DOC, h, deps({ cache }));
    now = 29_999;
    await loadQditReceipts(DOC, h, deps({ cache }));
    expect(simulate).toHaveBeenCalledTimes(1);
    now = 30_000;
    await loadQditReceipts(DOC, h, deps({ cache }));
    expect(simulate).toHaveBeenCalledTimes(2);
  });
});

describe("qditExplorerUrl", () => {
  it("links to stellar.expert on the ref's network (`public` for mainnet)", () => {
    expect(qditExplorerUrl("testnet", "tx", APPROVAL_TX)).toBe(`https://stellar.expert/explorer/testnet/tx/${APPROVAL_TX}`);
    expect(qditExplorerUrl("mainnet", "contract", CONTRACT)).toBe(`https://stellar.expert/explorer/public/contract/${CONTRACT}`);
  });
});
