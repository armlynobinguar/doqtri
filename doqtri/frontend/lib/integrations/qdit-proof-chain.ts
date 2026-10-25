import type { MilestoneChainRecord, QditArtifactRef } from "@/lib/integrations/qdit-chain";
import { chainRead, type QditReceipt } from "@/lib/integrations/qdit-receipts";
import type { ChainDocument } from "@/lib/stellar/contract-client";
import type { ChainNodeEvent, DocumentHistory } from "@/lib/stellar/history";

/**
 * The full proof chain of one heading signed from a qdit milestone (WP-3.3;
 * pure, rendered by components/audit/qdit-proof-chain.tsx).
 * docs/integration/CONTRACT.md section 12 is the reference: its four facts,
 * in order, for node `N` of doc `D` whose record names milestone `M` at
 * `@vV`:
 *
 *   1. plan version: DoqtriRegistry's current Document (version, hash,
 *      update time) and the version that was in effect when doqtri's write
 *      set N's record, both with their anchoring transaction from doqtri's
 *      own history;
 *   2. submitted: milestone_proof's record for M, compared with `V`;
 *   3. approved: that record Approved at `V` itself;
 *   4. verified: N's record with `tool = "qdit"` and `status = Verified`,
 *      its signer and transaction. It holds only together with fact 3 at
 *      the same `V`.
 *
 * Each step is `done`, `pending` (the chain says it has not happened, or
 * not yet for `V`), or `unchecked` (it could not be checked: Stellar did not
 * answer, the ref is not the note's linked project's, or the chain
 * contradicts the record). Everything comes from the receipt WP-3.1 built
 * (lib/integrations/qdit-receipts.ts) and the history and Document the page
 * already read: no further reads, and nothing from qdit's API or doqtri's
 * link rows, so the anonymous rules of section 12 hold as they do for the
 * receipt. In particular the plan version in step 1 is the one the chain
 * shows was in effect when N was signed, not the `doc_version` a link row
 * holds.
 *
 * Transactions: doqtri's own writes come from its history; the approval from
 * qdit_milestone_approvals when doqtri recorded it. Nothing records the
 * submission's transaction, so step 2 always names the contract instead
 * and says doqtri does not record it (section 12: a page MUST still show
 * the fact).
 */

export type StepState = "done" | "pending" | "unchecked";

/** A DoqtriRegistry document version and the write that anchored it. */
export type PlanVersion = {
  version: number;
  contentHash: string;
  /** The anchoring transaction, when the history read found it. */
  txHash: string | null;
  /** When it was anchored (ISO), when known. */
  closedAt: string | null;
};

/** Why a step could not be checked. */
export type UncheckedReason =
  /** Stellar did not answer, or the named contract is not milestone_proof. */
  | "unreachable"
  /** The record's artifact_ref does not follow section 10. */
  | "invalid_ref"
  /** doqtri could not read its own records to check the ref against. */
  | "link"
  /** The ref does not name the note's linked project and its contract. */
  | "mismatch"
  /** The chain holds an older version than `V`. */
  | "older"
  /** The chain has no record of the milestone. */
  | "missing";

export type PlanStep = {
  key: "plan";
  /** `unchecked` when the version in effect at signing is not in the history read. */
  state: "done" | "unchecked";
  current: PlanVersion;
  /** The version in effect when doqtri's write set the record; null when unknown. */
  signedAt: PlanVersion | null;
};

export type SubmittedStep = {
  key: "submitted";
  state: StepState;
  /** The version the heading was signed against (`@vV`); null for an invalid ref. */
  version: number | null;
  /** What milestone_proof holds now; null when nothing was read or it has no record. */
  chain: MilestoneChainRecord | null;
  /** The ledger the read saw. */
  ledger: number | null;
  /** The chain holds a later submission than `V`. */
  newer: boolean;
  reason?: UncheckedReason;
};

export type ApprovedStep = {
  key: "approved";
  state: StepState;
  version: number | null;
  chain: MilestoneChainRecord | null;
  newer: boolean;
  /** The approval of the version the chain holds, when recorded. */
  txHash: string | null;
  txLedger: number | null;
  reason?: UncheckedReason;
};

export type VerifiedStep = {
  key: "verified";
  /**
   * `done` only for a Verified record with step 3 done; `pending` for a
   * record not (yet) Verified; `unchecked` for a Verified record step 3
   * does not back, whatever the reason.
   */
  state: StepState;
  /** The record's status as DoqtriRegistry holds it. */
  status: string;
  signing: ChainNodeEvent | null;
  /** The record's ledger time (seconds), when the contract answered. */
  updatedAt: number | null;
};

export type ProofChain = {
  nodeId: string;
  /**
   * The ref, when it may be offered as qdit's milestone_proof: only once
   * doqtri compared it with the note's linked project and it matched.
   * Null when the link could not be read, did not match, or the ref does
   * not parse, so a look-alike contract is never named as qdit's.
   */
  qditContract: QditArtifactRef | null;
  steps: [PlanStep, SubmittedStep, ApprovedStep, VerifiedStep];
  /** Steps done, out of four. */
  done: number;
};

/** The page's reads that the plan step needs. */
export type PlanContext = {
  doc: ChainDocument;
  history: DocumentHistory | null;
};

function versionEntry(history: DocumentHistory | null, version: number): PlanVersion | null {
  // An incomplete history numbers versions by what it found (history.ts).
  if (!history || history.incomplete) return null;
  const v = history.versions.find((entry) => entry.version === version);
  return v ? { version: v.version, contentHash: v.contentHash, txHash: v.txHash, closedAt: v.closedAt } : null;
}

export function planStep(receipt: QditReceipt, { doc, history }: PlanContext): PlanStep {
  const found = versionEntry(history, doc.version);
  // The chain's value wins for the current version, as on the rest of the page.
  const current: PlanVersion = {
    version: doc.version,
    contentHash: doc.contentHash,
    txHash: found?.contentHash === doc.contentHash ? found.txHash : null,
    closedAt: found?.contentHash === doc.contentHash ? found.closedAt : null,
  };
  const at = receipt.signing?.docVersion;
  const signedAt = at && at >= 1 && at <= doc.version ? versionEntry(history, at) : null;
  return { key: "plan", state: signedAt ? "done" : "unchecked", current, signedAt };
}

/** The ref, when it was checked against the note's linked project and matched. */
function vouchedRef({ ref, check }: QditReceipt): QditArtifactRef | null {
  // A read (or a failed read: "rpc", "contract") happens only after the match.
  const matched =
    chainRead(check) != null ||
    (check.state === "unreachable" && (check.reason === "rpc" || check.reason === "contract"));
  return matched ? ref : null;
}

/** Why the chain could not speak for `V`, or null when it can. */
function uncheckedReason(receipt: QditReceipt): UncheckedReason | null {
  const { check, ref } = receipt;
  if (check.state === "unreachable") return check.reason === "rpc" || check.reason === "contract" ? "unreachable" : check.reason;
  if (check.mismatch) return "mismatch";
  if (!ref || !check.chain) return "missing";
  return check.chain.version < ref.version ? "older" : null;
}

export function proofChain(receipt: QditReceipt, context: PlanContext): ProofChain {
  const version = receipt.ref?.version ?? null;
  const read = chainRead(receipt.check);
  const chain = read?.chain ?? null;
  const reason = uncheckedReason(receipt);
  const newer = !reason && chain != null && version != null && chain.version > version;
  const atV = !reason && !newer;

  // Step 2. A record at V that is still Proposed has not been submitted; a
  // later version means V was submitted too (versions count submissions).
  const submitted: SubmittedStep = {
    key: "submitted",
    state: reason ? "unchecked" : atV && chain!.status === "Proposed" ? "pending" : "done",
    version,
    chain,
    ledger: read?.ledger ?? null,
    newer,
    ...(reason ? { reason } : {}),
  };

  // Step 3. Only Approved at V itself. Approved is terminal, so a record
  // newer than V means V was not the approved one (checkReceipt).
  const approvedAtV = atV && chain!.status === "Approved";
  const approved: ApprovedStep = {
    key: "approved",
    state: reason ? "unchecked" : approvedAtV ? "done" : "pending",
    version,
    chain,
    newer,
    // The recorded approval is the chain's current version's, which may be
    // newer than V; none is offered for a chain that can't speak for V.
    txHash: !reason && chain?.status === "Approved" ? receipt.approvalTxHash : null,
    txLedger: !reason && chain?.status === "Approved" ? receipt.approvalLedger : null,
    ...(reason ? { reason } : {}),
  };

  // Step 4. Never verified without step 3 at the same V.
  const isVerified = receipt.record.status === "Verified";
  const verified: VerifiedStep = {
    key: "verified",
    state: !isVerified ? "pending" : approved.state === "done" ? "done" : "unchecked",
    status: receipt.record.status,
    signing: receipt.signing,
    updatedAt: receipt.record.updatedAt,
  };

  const steps: ProofChain["steps"] = [planStep(receipt, context), submitted, approved, verified];
  return {
    nodeId: receipt.nodeId,
    qditContract: vouchedRef(receipt),
    steps,
    done: steps.filter((s) => s.state === "done").length,
  };
}
