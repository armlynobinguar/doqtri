import { describe, expect, it } from "vitest";
import { parseQditArtifactRef, type MilestoneChainStatus } from "@/lib/integrations/qdit-chain";
import { proofChain, type PlanContext } from "@/lib/integrations/qdit-proof-chain";
import type { QditReceipt, ReceiptCheck } from "@/lib/integrations/qdit-receipts";
import type { DocumentHistory } from "@/lib/stellar/history";

/*
 * The four steps of the public chain view (WP-3.3, CONTRACT.md section 12),
 * in each state they can take. Pure: receipts as WP-3.1's loader builds
 * them, and the history and Document the page read.
 */

const CONTRACT = "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG";
const REF = (v: number) =>
  `qdit:testnet:${CONTRACT}:3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34/c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72@v${v}`;
const SIGNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TX = (n: number) => n.toString(16).padStart(64, "0");
const HASH = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

const onChain = (status: MilestoneChainStatus, version: number) => ({
  status,
  version,
  proofHash: "02".repeat(32),
  submitter: SIGNER,
  timestamp: 1_761_393_600,
});

/** A Verified heading signed against v2 while the plan was at v2, now at v3. */
function receipt(overrides: Partial<QditReceipt> & { v?: number; status?: string } = {}): QditReceipt {
  const { v = 2, status = "Verified", ...rest } = overrides;
  return {
    nodeId: "h4",
    record: { status, artifactRef: REF(v), updatedAt: 1_792_800_000 },
    ref: parseQditArtifactRef(REF(v)),
    signing: {
      nodeId: "h4",
      status,
      tool: "qdit",
      artifactRef: REF(v),
      txHash: TX(20),
      closedAt: "2026-10-24T12:00:00Z",
      docVersion: 2,
      signer: SIGNER,
      signerFrom: "call",
    },
    check: { state: "confirmed", chain: onChain("Approved", v), ledger: 5000 },
    approvalTxHash: TX(30),
    approvalLedger: 4990,
    qditPageUrl: null,
    ...rest,
  };
}

const HISTORY: DocumentHistory = {
  owner: SIGNER,
  versions: [1, 2, 3].map((version) => ({
    version,
    contentHash: HASH(version),
    txHash: TX(version),
    closedAt: `2026-10-2${version}T10:00:00Z`,
    signer: SIGNER,
    signerFrom: "call" as const,
  })),
  nodeEvents: [],
  nodes: [],
};

const CONTEXT: PlanContext = {
  doc: { version: 3, nodeCount: 5, contentHash: HASH(3), updatedAt: 1_792_843_200, owner: SIGNER },
  history: HISTORY,
};

const states = (r: QditReceipt, context = CONTEXT) => proofChain(r, context).steps.map((s) => s.state);
const differs = (status: MilestoneChainStatus, version: number): ReceiptCheck => ({
  state: "differs",
  chain: onChain(status, version),
  ledger: 5000,
});

describe("proofChain: the whole chain", () => {
  it("all four done: plan version known, submitted and approved at vV, signed Verified", () => {
    const chain = proofChain(receipt(), CONTEXT);
    expect(chain.done).toBe(4);
    const [plan, submitted, approved, verified] = chain.steps;
    expect(plan).toEqual({
      key: "plan",
      state: "done",
      current: { version: 3, contentHash: HASH(3), txHash: TX(3), closedAt: "2026-10-23T10:00:00Z" },
      signedAt: { version: 2, contentHash: HASH(2), txHash: TX(2), closedAt: "2026-10-22T10:00:00Z" },
    });
    expect(submitted).toMatchObject({ state: "done", version: 2, chain: { status: "Approved", version: 2 }, ledger: 5000, newer: false });
    expect(submitted.reason).toBeUndefined();
    expect(approved).toMatchObject({ state: "done", txHash: TX(30), txLedger: 4990 });
    expect(verified).toMatchObject({ state: "done", status: "Verified", updatedAt: 1_792_800_000 });
    expect(verified.signing?.txHash).toBe(TX(20));
    expect(chain.qditContract).toMatchObject({ contractId: CONTRACT, version: 2 });
  });

  it.each<[string, ReceiptCheck, boolean]>([
    ["read", { state: "confirmed", chain: onChain("Approved", 2), ledger: 5000 }, true],
    ["read, no record", { state: "differs", chain: null, ledger: 5000 }, true],
    ["matched, Stellar did not answer", { state: "unreachable", reason: "rpc" }, true],
    ["matched, not a milestone_proof", { state: "unreachable", reason: "contract" }, true],
    ["link rows unreadable", { state: "unreachable", reason: "link" }, false],
    ["not the linked project's", { state: "differs", mismatch: "project" }, false],
    ["not the linked contract", { state: "differs", mismatch: "chain" }, false],
  ])("offers the ref as qdit's contract only once it matched the linked project: %s", (_, check, offered) => {
    const chain = proofChain(receipt({ check }), CONTEXT);
    expect(chain.qditContract != null).toBe(offered);
  });
});

describe("proofChain: step 1, plan version", () => {
  it("unchecked when the signing write is not in the history read", () => {
    const [plan] = proofChain(receipt({ signing: null }), CONTEXT).steps;
    expect(plan.state).toBe("unchecked");
    expect(plan.signedAt).toBeNull();
    // The current version is still the chain's own.
    expect(plan.current).toMatchObject({ version: 3, contentHash: HASH(3) });
  });

  it("unchecked when the history is incomplete: its version numbers can't be trusted", () => {
    const [plan] = proofChain(receipt(), { ...CONTEXT, history: { ...HISTORY, incomplete: true } }).steps;
    expect(plan.state).toBe("unchecked");
    expect(plan.current).toEqual({ version: 3, contentHash: HASH(3), txHash: null, closedAt: null });
  });

  it("unchecked with no history at all; the current version comes from the Document", () => {
    const [plan] = proofChain(receipt(), { ...CONTEXT, history: null }).steps;
    expect(plan.state).toBe("unchecked");
    expect(plan.current).toEqual({ version: 3, contentHash: HASH(3), txHash: null, closedAt: null });
  });

  it("the current version's transaction is shown only when the history's hash is the chain's", () => {
    const lagging = { ...HISTORY, versions: HISTORY.versions.map((v) => (v.version === 3 ? { ...v, contentHash: HASH(9) } : v)) };
    const [plan] = proofChain(receipt(), { ...CONTEXT, history: lagging }).steps;
    expect(plan.current.txHash).toBeNull();
    expect(plan.state).toBe("done");
  });

  it("done at the current version when the plan has not changed since signing", () => {
    const r = receipt();
    const [plan] = proofChain({ ...r, signing: { ...r.signing!, docVersion: 3 } }, CONTEXT).steps;
    expect(plan.signedAt?.version).toBe(plan.current.version);
  });
});

describe("proofChain: steps 2 and 3, submitted and approved", () => {
  it("submitted at vV, not yet approved: submitted done, approved pending", () => {
    expect(states(receipt({ status: "Built", check: { state: "confirmed", chain: onChain("Submitted", 2), ledger: 5000 } }))).toEqual([
      "done",
      "done",
      "pending",
      "pending",
    ]);
  });

  it("rejected at vV: submitted done, approved pending", () => {
    const chain = proofChain(receipt({ status: "Building", check: { state: "confirmed", chain: onChain("Rejected", 2), ledger: 5000 } }), CONTEXT);
    expect(chain.steps.map((s) => s.state)).toEqual(["done", "done", "pending", "pending"]);
    expect(chain.steps[2]).toMatchObject({ chain: { status: "Rejected" }, txHash: null });
  });

  it("a record still Proposed at vV: submitted pending", () => {
    expect(states(receipt({ status: "Planned", check: { state: "confirmed", chain: onChain("Proposed", 2), ledger: 5000 } }))).toEqual([
      "done",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("a newer submission, signed Verified: step 3 speaks for the current record, step 4 does not match", () => {
    // Signed Verified against v1; v1 was rejected and v2 approved since.
    const chain = proofChain(receipt({ v: 1, check: differs("Approved", 2) }), CONTEXT);
    const [, submitted, approved, verified] = chain.steps;
    expect(submitted).toMatchObject({ state: "done", newer: true, version: 1, chain: { version: 2 } });
    // D-78: keyed on the current record, as qdit's page is; the heading's v1 is named.
    expect(approved).toMatchObject({ state: "done", newer: true, signedFor: 1, txHash: TX(30) });
    // Never verified without the record Approved at the same version: checked, and it contradicts.
    expect(verified.state).toBe("mismatch");
    expect(chain.done).toBe(3);
  });

  it("fixture M2: signed Built @v1, v1 rejected, v2 approved: step 3 done for v2, step 4 pending", () => {
    const chain = proofChain(receipt({ v: 1, status: "Built", check: differs("Approved", 2) }), CONTEXT);
    expect(chain.steps.map((s) => s.state)).toEqual(["done", "done", "done", "pending"]);
    expect(chain.steps[2]).toMatchObject({ chain: { status: "Approved", version: 2 }, signedFor: 1 });
  });

  it("a newer submission not yet decided: step 3 pending, with the heading's version named", () => {
    const [, submitted, approved] = proofChain(receipt({ v: 1, status: "Built", check: differs("Submitted", 2) }), CONTEXT).steps;
    expect(submitted).toMatchObject({ state: "done", newer: true });
    expect(approved).toMatchObject({ state: "pending", signedFor: 1, txHash: null });
  });

  it.each([
    ["Stellar did not answer", { state: "unreachable", reason: "rpc" }, "unreachable", "unchecked"],
    ["the contract is not milestone_proof", { state: "unreachable", reason: "contract" }, "unreachable", "unchecked"],
    ["the ref is not in section 10's grammar", { state: "unreachable", reason: "invalid_ref" }, "invalid_ref", "unchecked"],
    ["doqtri's own records could not be read", { state: "unreachable", reason: "link" }, "link", "unchecked"],
  ] as const)("steps 2 and 3 could not check when %s", (_, check, reason, verifiedState) => {
    const chain = proofChain(receipt({ check: check as ReceiptCheck }), CONTEXT);
    const [, submitted, approved, verified] = chain.steps;
    expect(submitted).toMatchObject({ state: "unchecked", reason });
    expect(approved).toMatchObject({ state: "unchecked", reason, txHash: null, signedFor: null });
    expect(verified.state).toBe(verifiedState);
  });

  it.each(["unlinked", "project", "no_chain", "chain"] as const)(
    "every link mismatch reads the same, so nothing about the link row shows (%s)",
    (mismatch) => {
      expect(states(receipt({ check: { state: "differs", mismatch } }))).toEqual(["mismatch", "mismatch", "mismatch", "mismatch"]);
    },
  );

  it("a ref deliberately not read (D-79) does not match on steps 1 to 3, never could not check (D-93)", () => {
    const chain = proofChain(receipt({ check: { state: "differs", mismatch: "chain" }, approvalTxHash: TX(30) }), CONTEXT);
    const [plan, submitted, approved, verified] = chain.steps;
    // Step 1 still shows the registry's own versions.
    expect(plan).toMatchObject({ state: "mismatch", conflict: "link", current: { version: 3 }, signedAt: { version: 2 } });
    expect(submitted).toMatchObject({ state: "mismatch", conflict: "link", chain: null, ledger: null, newer: false });
    expect(submitted.reason).toBeUndefined();
    expect(approved).toMatchObject({ state: "mismatch", conflict: "link", chain: null, signedFor: null, txHash: null, txLedger: null });
    expect(approved.reason).toBeUndefined();
    expect(verified.state).toBe("mismatch");
    expect(chain.done).toBe(0);
    expect(chain.qditContract).toBeNull();
    // A heading not signed Verified is not a contradiction at step 4, only at 1 to 3.
    expect(states(receipt({ status: "Built", check: { state: "differs", mismatch: "project" } }))).toEqual([
      "mismatch",
      "mismatch",
      "mismatch",
      "pending",
    ]);
    // Even without the signing write in the history, step 1 says the ref does not match.
    expect(proofChain(receipt({ signing: null, check: { state: "differs", mismatch: "unlinked" } }), CONTEXT).steps[0]).toMatchObject({
      state: "mismatch",
      signedAt: null,
    });
  });

  it("the chain has no record of vV: step 2 does not match, step 3 pending", () => {
    const [, submitted, approved, verified] = proofChain(receipt({ check: { state: "differs", chain: null, ledger: 5000 } }), CONTEXT).steps;
    expect(submitted).toMatchObject({ state: "mismatch", conflict: "missing" });
    expect(submitted.reason).toBeUndefined();
    expect(approved).toMatchObject({ state: "pending", chain: null, signedFor: null, txHash: null });
    expect(verified.state).toBe("mismatch");
  });

  it("the chain is behind vV: step 2 does not match, step 3 speaks for the record it holds", () => {
    const [, submitted, approved, verified] = proofChain(receipt({ check: differs("Approved", 1) }), CONTEXT).steps;
    expect(submitted).toMatchObject({ state: "mismatch", conflict: "older", chain: { version: 1 } });
    expect(approved).toMatchObject({ state: "done", signedFor: 2 });
    expect(verified.state).toBe("mismatch");
  });

  it("a Planned heading with no record on chain is still a contradiction at step 2, not at step 4", () => {
    expect(states(receipt({ status: "Planned", check: { state: "differs", chain: null, ledger: 5000 } }))).toEqual([
      "done",
      "mismatch",
      "pending",
      "pending",
    ]);
  });

  it("no approval transaction recorded: approved is still done, from the chain's state", () => {
    const [, , approved] = proofChain(receipt({ approvalTxHash: null, approvalLedger: null }), CONTEXT).steps;
    expect(approved).toMatchObject({ state: "done", txHash: null, txLedger: null });
  });
});

describe("proofChain: step 4, verified", () => {
  it("pending for a record not signed as Verified, even once the chain approved vV", () => {
    const chain = proofChain(receipt({ status: "Built", check: differs("Approved", 2) }), CONTEXT);
    expect(chain.steps.map((s) => s.state)).toEqual(["done", "done", "done", "pending"]);
    expect(chain.steps[3]).toMatchObject({ status: "Built" });
  });

  it("fixture M3: does not match for a Verified record the chain says is Submitted at vV", () => {
    const [, , approved, verified] = proofChain(receipt({ check: differs("Submitted", 2) }), CONTEXT).steps;
    expect(approved).toMatchObject({ state: "pending", signedFor: null });
    expect(verified).toMatchObject({ state: "mismatch", status: "Verified" });
  });

  it("does not match for a Verified record whose v2 was rejected", () => {
    expect(states(receipt({ check: differs("Rejected", 2) }))).toEqual(["done", "done", "pending", "mismatch"]);
  });

  it("could not check a Verified record when Stellar did not answer", () => {
    const [, , , verified] = proofChain(receipt({ check: { state: "unreachable", reason: "rpc" } }), CONTEXT).steps;
    expect(verified).toMatchObject({ state: "unchecked", status: "Verified" });
  });

  it("keeps no record time when the contract could not be asked", () => {
    const r = receipt();
    const [, , , verified] = proofChain({ ...r, record: { ...r.record, updatedAt: null } }, CONTEXT).steps;
    expect(verified).toMatchObject({ state: "done", updatedAt: null });
  });
});
