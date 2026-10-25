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
 *   3. approved: that record, as it stands now, Approved (D-78: keyed on the
 *      current on-chain record, as on qdit's page, with a note when `V` is
 *      another version);
 *   4. verified: N's record with `tool = "qdit"` and `status = Verified`,
 *      its signer and transaction. It holds only with the record Approved
 *      at `V` itself.
 *
 * Each step is one of the four states qdit's page uses too (D-78; qdit's
 * web/src/lib/proof-chain.ts), in the same words: `done` ("Done", the chain
 * says it happened), `pending` ("Pending", the chain says it has not, or
 * not yet), `mismatch` ("Does not match": checked, and the records
 * contradict each other, for example a heading signed Verified that the
 * chain does not back), or `unchecked` ("Could not check": Stellar did not
 * answer, the ref does not parse, or the ref is not the note's linked
 * project's so its contract was not read). Everything comes from the
 * receipt WP-3.1 built (lib/integrations/qdit-receipts.ts) and the history
 * and Document the page already read: no further reads, and nothing from
 * qdit's API or doqtri's link rows, so the anonymous rules of section 12
 * hold as they do for the receipt. In particular the plan version in step 1
 * is the one the chain shows was in effect when N was signed, not the
 * `doc_version` a link row holds.
 *
 * Transactions: doqtri's own writes come from its history; the approval from
 * qdit_milestone_approvals when doqtri recorded it. Nothing records the
 * submission's transaction, so step 2 always names the contract instead
 * and says doqtri does not record it (section 12: a page MUST still show
 * the fact).
 */

export type StepState = "done" | "pending" | "mismatch" | "unchecked";

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
  /**
   * The ref does not name the note's linked project and its contract, so
   * that contract was not read (D-79). One reason whatever the mismatch, so
   * nothing about the link row shows.
   */
  | "link_mismatch";

/** How the chain, read, contradicts the version `V` the heading names. */
export type ChainConflict =
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
  /** Set when the state is `unchecked`. */
  reason?: UncheckedReason;
  /** Set when the state is `mismatch`: the chain has no submission at `V`. */
  conflict?: ChainConflict;
};

export type ApprovedStep = {
  key: "approved";
  /** Keyed on the current record (D-78): `done` when it is Approved, whatever its version. */
  state: StepState;
  version: number | null;
  chain: MilestoneChainRecord | null;
  newer: boolean;
  /**
   * `V`, when the current record the step speaks for is another version:
   * "the heading was signed for vV". Null when they agree or nothing was
   * read.
   */
  signedFor: number | null;
  /** The approval of the version the chain holds, when recorded. */
  txHash: string | null;
  txLedger: number | null;
  reason?: UncheckedReason;
};

export type VerifiedStep = {
  key: "verified";
  /**
   * `done` only for a Verified record the chain holds Approved at `V`;
   * `pending` for a record not (yet) Verified; `mismatch` for a Verified
   * record the chain, read, does not back (or whose ref is not the note's
   * linked project's); `unchecked` for one whose milestone could not be
   * read at all.
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

/** Why the chain could not be asked about `V`, or null when it was read. */
function uncheckedReason({ check }: QditReceipt): UncheckedReason | null {
  if (check.state === "unreachable") return check.reason === "rpc" || check.reason === "contract" ? "unreachable" : check.reason;
  return check.mismatch ? "link_mismatch" : null;
}

/** How the record that was read contradicts `V`, or null when it does not. */
function chainConflict({ ref }: QditReceipt, chain: MilestoneChainRecord | null): ChainConflict | null {
  if (!ref || !chain) return "missing";
  return chain.version < ref.version ? "older" : null;
}

export function proofChain(receipt: QditReceipt, context: PlanContext): ProofChain {
  const version = receipt.ref?.version ?? null;
  const read = chainRead(receipt.check);
  const chain = read?.chain ?? null;
  const reason = uncheckedReason(receipt);
  const conflict = reason ? null : chainConflict(receipt, chain);
  const newer = !reason && chain != null && version != null && chain.version > version;
  const atV = !reason && chain != null && chain.version === version;

  // Step 2. A record at V that is still Proposed has not been submitted; a
  // later version means V was submitted too (versions count submissions).
  // A record older than V, or none, contradicts a ref that names V.
  const submitted: SubmittedStep = {
    key: "submitted",
    state: reason ? "unchecked" : conflict ? "mismatch" : atV && chain!.status === "Proposed" ? "pending" : "done",
    version,
    chain,
    ledger: read?.ledger ?? null,
    newer,
    ...(reason ? { reason } : {}),
    ...(conflict ? { conflict } : {}),
  };

  // Step 3. Keyed on the current record, as qdit's page is (D-78): done when
  // it is Approved, with the heading's own version named when it differs.
  const approved: ApprovedStep = {
    key: "approved",
    state: reason ? "unchecked" : chain?.status === "Approved" ? "done" : "pending",
    version,
    chain,
    newer,
    signedFor: !reason && chain != null && version != null && chain.version !== version ? version : null,
    // The recorded approval is the chain's current version's.
    txHash: !reason && chain?.status === "Approved" ? receipt.approvalTxHash : null,
    txLedger: !reason && chain?.status === "Approved" ? receipt.approvalLedger : null,
    ...(reason ? { reason } : {}),
  };

  // Step 4. Never verified without the record Approved at the same V.
  // A Verified heading the chain was read against and does not back is a
  // contradiction, not a failed check; so is one whose ref is not the note's
  // linked project's.
  const isVerified = receipt.record.status === "Verified";
  const backed = atV && chain!.status === "Approved";
  const verified: VerifiedStep = {
    key: "verified",
    state: !isVerified
      ? "pending"
      : backed
        ? "done"
        : reason && reason !== "link_mismatch"
          ? "unchecked"
          : "mismatch",
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
