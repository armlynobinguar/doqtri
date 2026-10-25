import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRow } from "@/lib/integrations/qdit-approvals";
import { readMilestoneRecord, type SimulateCall } from "@/lib/integrations/qdit-chain";
import { qditPublicOrigin } from "@/lib/integrations/qdit-config";
import {
  createReadCache,
  isQditPagePublished,
  loadQditReceipts,
  PUBLIC_PAGE_TTL_MS,
  qditExplorerUrl,
  qditMilestonePageUrl,
  type LinkedProject,
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
  m2_submitted_v2:
    "AAAAEQAAAAEAAAAHAAAADwAAAAxtaWxlc3RvbmVfaWQAAAAOAAAAJGM5MmY1MDE4LTdiM2QtNGVhNC05ZjYwLTFkOGIwYzRlM2Y3MgAAAA8AAAAKcHJvamVjdF9pZAAAAAAADgAAACQzZjZjMmExZS04YjRkLTRjN2UtOWExMC0yZDViN2U5ZjFjMzQAAAAPAAAACnByb29mX2hhc2gAAAAAAA0AAAAgAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAAAAPAAAABnN0YXR1cwAAAAAAEAAAAAEAAAABAAAADwAAAAlTdWJtaXR0ZWQAAAAAAAAPAAAACXN1Ym1pdHRlcgAAAAAAABIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAPAAAACXRpbWVzdGFtcAAAAAAAAAUAAAAAAAAAAAAAAA8AAAAHdmVyc2lvbgAAAAADAAAAAg==",
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

/**
 * Fact 2 as the fixtures hold it: each milestone's proof hash, the test
 * host's submitter contract, and ledger time 0 (the test host's clock).
 */
const SUBMITTER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const PROOF_HASH: Record<string, string> = { [M1]: "ab".repeat(32), [M2]: "02".repeat(32), [M3]: "33".repeat(32) };
const onChain = (milestone: string, status: string, version: number) => ({
  status,
  version,
  proofHash: PROOF_HASH[milestone],
  submitter: SUBMITTER,
  timestamp: 0,
});

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
/** The note's doc_project_links row as the page reads it. */
let linked: LinkedProject | null;

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
    linkedProject: vi.fn(async () => linked),
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
  linked = { projectId: PROJECT, slug: "soroban-payroll", chain: { network: "testnet", contractId: CONTRACT } };
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
    expect(d.linkedProject).not.toHaveBeenCalled();
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
    expect(d.linkedProject).not.toHaveBeenCalled();
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
    expect(r.check).toEqual({ state: "confirmed", chain: onChain(M2, "Approved", 2), ledger: 5000 });
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

  it("differs when the chain is at a later version: v1 was resubmitted, so v2's approval does not back it", async () => {
    // Approved is terminal in milestone_proof, so Approved at v2 means the v1
    // this heading was signed against was rejected and resubmitted.
    approvalRows = [
      { network: "testnet", contract_id: CONTRACT, project_id: PROJECT, milestone_id: M2, version: 2, tx_hash: APPROVAL_TX },
    ];
    const h = setup([event("h1", "Verified", ref(M2, 1), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toEqual({ state: "differs", chain: onChain(M2, "Approved", 2), ledger: 5000 });
    // The approval shown is v2's, which the component labels as such.
    expect(r.approvalTxHash).toBe(APPROVAL_TX);
  });

  it("differs for any status when the chain is ahead of the ref, even one the newer record would match", async () => {
    // A Built record against v1; the chain holds a newer submission, v2.
    answers[M2] = "m2_submitted_v2";
    const h = setup([event("h1", "Built", ref(M2, 1), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toEqual({ state: "differs", chain: onChain(M2, "Submitted", 2), ledger: 5000 });
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
      ["h1", { state: "differs", chain: onChain(M1, "Submitted", 1), ledger: 5000 }],
      ["h2", { state: "differs", chain: onChain(M3, "Rejected", 1), ledger: 5000 }],
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

describe("loadQditReceipts: the note's linked project (section 12)", () => {
  /** A contract that is not the linked project's: a look-alike milestone_proof answering Approved. */
  const LOOKALIKE = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
  const OTHER_PROJECT = "4a7d3b2f-9c5e-4d8f-8b21-3e6c8f0a2d45";
  const refTo = (contract: string, project = PROJECT, network = "testnet") =>
    `qdit:${network}:${contract}:${project}/${M2}@v2`;

  it("a ref naming another contract is unverified, and that contract is never asked", async () => {
    // The look-alike would answer Approved at v2 (the fake simulate answers any contract).
    const h = setup([event("h1", "Verified", refTo(LOOKALIKE), 1)]);
    const d = deps();
    const [r] = (await loadQditReceipts(DOC, h, d))!.receipts;
    expect(r.check).toEqual({ state: "differs", mismatch: "chain" });
    expect(simulate).not.toHaveBeenCalled();
    expect(d.approvals).not.toHaveBeenCalled();
    expect(r.approvalTxHash).toBeNull();
  });

  it("a ref on the other network is unverified, even with the same contract id", async () => {
    const h = setup([event("h1", "Verified", refTo(CONTRACT, PROJECT, "mainnet"), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toEqual({ state: "differs", mismatch: "chain" });
    expect(simulate).not.toHaveBeenCalled();
  });

  it("a ref naming another project than the linked one is unverified", async () => {
    answers[M2] = "m2_approved_v2";
    const h = setup([event("h1", "Verified", refTo(CONTRACT, OTHER_PROJECT), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.check).toEqual({ state: "differs", mismatch: "project" });
    expect(simulate).not.toHaveBeenCalled();
  });

  it("unverified when the linked project has no stored chain yet, or the note is not linked", async () => {
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    linked = { projectId: PROJECT, slug: "soroban-payroll", chain: null };
    expect((await loadQditReceipts(DOC, h, deps()))!.receipts[0].check).toEqual({ state: "differs", mismatch: "no_chain" });
    linked = null;
    expect((await loadQditReceipts(DOC, h, deps()))!.receipts[0].check).toEqual({ state: "differs", mismatch: "unlinked" });
    expect(simulate).not.toHaveBeenCalled();
  });

  it("not checked when the link can't be read: fails closed, never confirmed", async () => {
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps({ linkedProject: async () => Promise.reject(new Error("db down")) })))!.receipts;
    expect(r.check).toEqual({ state: "unreachable", reason: "link" });
    expect(simulate).not.toHaveBeenCalled();
  });

  it("reads the link once per view, and checks each heading on its own", async () => {
    const h = setup([
      event("h1", "Verified", ref(M2, 2), 1),
      event("h2", "Verified", refTo(LOOKALIKE), 2),
      event("h3", "Verified", ref(M2, 2, "mainnet"), 3),
    ]);
    const d = deps();
    const { receipts } = (await loadQditReceipts(DOC, h, d))!;
    expect(receipts.map((r) => r.check.state === "unreachable" ? r.check.reason : (r.check.mismatch ?? r.check.state))).toEqual([
      "confirmed",
      "chain",
      "chain",
    ]);
    expect(d.linkedProject).toHaveBeenCalledTimes(1);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(simulate.mock.calls[0][0].contractId).toBe(CONTRACT);
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

describe("loadQditReceipts: qdit's public milestone page (section 12)", () => {
  const ORIGIN = "https://qdit.example";
  const SLUG = "soroban payroll/ü";
  const pageUrl = (milestone: string) => `${ORIGIN}/p/${encodeURIComponent(SLUG)}/${milestone}`;

  beforeEach(() => {
    linked = { projectId: PROJECT, slug: SLUG, chain: { network: "testnet", contractId: CONTRACT } };
  });

  function withPage(overrides: Partial<NonNullable<ReceiptDeps["qditPage"]>> = {}) {
    const isPublished = vi.fn(async () => true);
    return { origin: ORIGIN, isPublished, cache: createReadCache<boolean>({ ttlMs: PUBLIC_PAGE_TTL_MS }), ...overrides };
  }

  it("links the page once qdit answers it anonymously, one check per page", async () => {
    const page = withPage();
    const h = setup([event("h1", "Verified", ref(M2, 2), 1), event("h2", "Verified", ref(M2, 2), 2), event("h3", "Built", ref(M1, 1), 3)]);
    const d = deps({ qditPage: page });
    const { receipts } = (await loadQditReceipts(DOC, h, d))!;
    expect(receipts.map((r) => r.qditPageUrl)).toEqual([pageUrl(M2), pageUrl(M2), pageUrl(M1)]);
    expect(d.linkedProject).toHaveBeenCalledTimes(1);
    expect(page.isPublished).toHaveBeenCalledTimes(2);
    expect(page.isPublished).toHaveBeenCalledWith(pageUrl(M2));
  });

  it("no link when qdit does not publish the page, or the ref names another project", async () => {
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    const unpublished = (await loadQditReceipts(DOC, h, deps({ qditPage: withPage({ isPublished: async () => false }) })))!;
    expect(unpublished.receipts[0].qditPageUrl).toBeNull();

    linked = { projectId: "4a7d3b2f-9c5e-4d8f-8b21-3e6c8f0a2d45", slug: SLUG, chain: { network: "testnet", contractId: CONTRACT } };
    const other = withPage();
    const result = (await loadQditReceipts(DOC, h, deps({ qditPage: other })))!;
    expect(result.receipts[0].qditPageUrl).toBeNull();
    expect(other.isPublished).not.toHaveBeenCalled();
  });

  it("no link without a linked project, when the link can't be read, or when the ref's contract is not the project's", async () => {
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    const cases: Array<() => Promise<LinkedProject | null>> = [
      async () => null,
      async () => Promise.reject(new Error("db down")),
      async () => ({ projectId: PROJECT, slug: SLUG, chain: { network: "mainnet", contractId: CONTRACT } }),
    ];
    for (const linkedProject of cases) {
      const page = withPage();
      const [r] = (await loadQditReceipts(DOC, h, deps({ qditPage: page, linkedProject })))!.receipts;
      expect(r.check.state).not.toBe("confirmed");
      expect(r.qditPageUrl).toBeNull();
      expect(page.isPublished).not.toHaveBeenCalled();
    }
  });

  it("no qdit page config (no qdit origin): no link and no check", async () => {
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    const [r] = (await loadQditReceipts(DOC, h, deps()))!.receipts;
    expect(r.qditPageUrl).toBeNull();
  });

  it("keeps qdit's answer for 10 minutes", async () => {
    let now = 0;
    const cache = createReadCache<boolean>({ ttlMs: PUBLIC_PAGE_TTL_MS, now: () => now });
    const page = withPage({ cache });
    const h = setup([event("h1", "Verified", ref(M2, 2), 1)]);
    await loadQditReceipts(DOC, h, deps({ qditPage: page }));
    now = PUBLIC_PAGE_TTL_MS - 1;
    await loadQditReceipts(DOC, h, deps({ qditPage: page }));
    expect(page.isPublished).toHaveBeenCalledTimes(1);
    now = PUBLIC_PAGE_TTL_MS;
    await loadQditReceipts(DOC, h, deps({ qditPage: page }));
    expect(page.isPublished).toHaveBeenCalledTimes(2);
  });

  it("builds the URL as section 12 does", () => {
    expect(qditMilestonePageUrl("https://qdit.example/", "a b/c", M2)).toBe(`https://qdit.example/p/a%20b%2Fc/${M2}`);
  });
});

describe("isQditPagePublished", () => {
  const URL_ = `https://qdit.example/p/soroban-payroll/${M2}`;

  it("asks anonymously with redirects off, and counts only a direct 200", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    expect(await isQditPagePublished(URL_, { fetch: fetchMock })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(new Headers(init.headers).has("cookie")).toBe(false);
  });

  it("a redirect, a 404, a network error or a timeout all count as not published", async () => {
    for (const status of [301, 302, 307, 404, 500]) {
      const answer = new Response(null, { status, headers: status < 400 ? { location: "https://qdit.example/login" } : {} });
      expect(await isQditPagePublished(URL_, { fetch: async () => answer })).toBe(false);
    }
    expect(await isQditPagePublished(URL_, { fetch: async () => Promise.reject(new TypeError("fetch failed")) })).toBe(false);
    const hang = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    expect(await isQditPagePublished(URL_, { fetch: hang as typeof fetch, timeoutMs: 10 })).toBe(false);
  });
});

describe("qditPublicOrigin", () => {
  it("is the origin of QDIT_API_BASE_URL, only with the integration on", () => {
    const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
    const on = { NEXT_PUBLIC_QDIT_INTEGRATION: "1" };
    expect(qditPublicOrigin(env({ ...on, QDIT_API_BASE_URL: "https://qdit.atalusan.com/api/v1" }))).toBe("https://qdit.atalusan.com");
    expect(qditPublicOrigin(env({ ...on, QDIT_API_BASE_URL: "http://localhost:3001/api/v1/" }))).toBe("http://localhost:3001");
    expect(qditPublicOrigin(env(on))).toBeNull();
    expect(qditPublicOrigin(env({ ...on, QDIT_API_BASE_URL: "not a url" }))).toBeNull();
    expect(qditPublicOrigin(env({ ...on, QDIT_API_BASE_URL: "ftp://qdit.example/api/v1" }))).toBeNull();
    expect(qditPublicOrigin(env({ QDIT_API_BASE_URL: "https://qdit.atalusan.com/api/v1" }))).toBeNull();
  });
});

describe("qditExplorerUrl", () => {
  it("links to stellar.expert on the ref's network (`public` for mainnet)", () => {
    expect(qditExplorerUrl("testnet", "tx", APPROVAL_TX)).toBe(`https://stellar.expert/explorer/testnet/tx/${APPROVAL_TX}`);
    expect(qditExplorerUrl("mainnet", "contract", CONTRACT)).toBe(`https://stellar.expert/explorer/public/contract/${CONTRACT}`);
  });
});
