import type { ApprovalRow } from "@/lib/integrations/qdit-approvals";
import {
  nodeStatusForMilestone,
  parseQditArtifactRef,
  QDIT_TOOL,
  QditChainError,
  type MilestoneChainRead,
  type MilestoneChainStatus,
  type ProjectChain,
  type QditArtifactRef,
  type QditChainNetwork,
} from "@/lib/integrations/qdit-chain";
import type { ChainNode } from "@/lib/stellar/contract-client";
import type { ChainNodeEvent, DocumentHistory } from "@/lib/stellar/history";

/**
 * qdit receipts on the public audit page (WP-3.1; server-only).
 * docs/integration/CONTRACT.md is the reference; section numbers point into
 * it.
 *
 * A heading whose current DoqtriRegistry record has `tool = "qdit"` was
 * signed from a qdit milestone, and its `artifact_ref` names the milestone
 * and the record version it was signed against (section 10). Its receipt
 * puts three things side by side, all from the chain or doqtri's own
 * records, none from qdit (the page has no qdit token):
 *
 *   - what milestone_proof says about the milestone now
 *     (`get_milestone_status` on the ref's contract and network);
 *   - doqtri's own write that set the record, from the history read the
 *     page already made;
 *   - the transaction that approved the milestone, when doqtri found its
 *     event while it was still in RPC's window (qdit_milestone_approvals,
 *     lib/integrations/qdit-approvals.ts).
 *
 * States: `confirmed` when the chain backs the record (the D-19 status of
 * what the chain says is the record's status, at a version at least the
 * ref's; for Verified that is Approved), `differs` when it says anything
 * else (both are shown, and a Verified record is not shown as approved),
 * and `unreachable` when it could not be checked.
 *
 * Bounded: at most MAX_RECEIPTS headings are checked per page view, each
 * with one get_node and one get_milestone_status simulation, a few at a
 * time; the rest are counted. Milestone reads are kept for CACHE_TTL_MS
 * per server instance, the same window the page itself revalidates in.
 * Off, and nothing is read, unless NEXT_PUBLIC_QDIT_INTEGRATION=1.
 */

export const MAX_RECEIPTS = 10;
export const CACHE_TTL_MS = 30_000;
const CONCURRENCY = 4;
const MAX_CACHE_ENTRIES = 500;

export type ReceiptCheck =
  | {
      state: "confirmed" | "differs";
      /** What milestone_proof holds now; null when it has no record (MilestoneNotFound). */
      chain: { status: MilestoneChainStatus; version: number } | null;
      /** The ledger the read saw. */
      ledger: number;
    }
  | {
      state: "unreachable";
      /** `rpc`: Stellar did not answer. `contract`: the named contract could not be read as milestone_proof. `invalid_ref`: the ref does not follow section 10. */
      reason: "rpc" | "contract" | "invalid_ref";
    };

export type QditReceipt = {
  nodeId: string;
  /** The heading's current DoqtriRegistry record. */
  record: { status: string; artifactRef: string };
  ref: QditArtifactRef | null;
  /** doqtri's write that set the record, when the history read found it. */
  signing: ChainNodeEvent | null;
  check: ReceiptCheck;
  /** The approval of the version the chain holds, when the chain says Approved and doqtri recorded it. */
  approvalTxHash: string | null;
};

export type QditReceipts = {
  receipts: QditReceipt[];
  /** Headings signed from qdit beyond MAX_RECEIPTS, not checked on this view. */
  more: number;
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** Whether the chain's word backs a record signed against `ref` (see the states above). */
export function checkReceipt(record: { status: string }, ref: QditArtifactRef, read: MilestoneChainRead): ReceiptCheck {
  const chain = read.record ? { status: read.record.status, version: read.record.version } : null;
  const backs = chain != null && chain.version >= ref.version && nodeStatusForMilestone(chain.status) === record.status;
  return { state: backs ? "confirmed" : "differs", chain, ledger: read.ledger };
}

/** The newest write in `history` that left `nodeId` with exactly this record. */
function signingEvent(history: DocumentHistory, nodeId: string, record: ChainNode | ChainNodeEvent): ChainNodeEvent | null {
  let found: ChainNodeEvent | null = null;
  for (const event of history.nodeEvents) {
    if (
      event.nodeId === nodeId &&
      event.status === record.status &&
      event.tool === record.tool &&
      event.artifactRef === record.artifactRef
    ) {
      found = event;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The milestone read cache
// ---------------------------------------------------------------------------

export type ReadCache = {
  get(key: string, load: () => Promise<MilestoneChainRead>): Promise<MilestoneChainRead>;
};

/** Reads kept for `ttlMs`; a failed read is not kept, so the next view asks again. */
export function createReadCache(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): ReadCache {
  const ttl = options.ttlMs ?? CACHE_TTL_MS;
  const max = options.maxEntries ?? MAX_CACHE_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { at: number; value: Promise<MilestoneChainRead> }>();
  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttl) return hit.value;
      entries.delete(key);
      const value = load();
      entries.set(key, { at: now(), value });
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
      return value;
    },
  };
}

/** This server instance's cache. */
export const receiptReadCache = createReadCache();

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type ReceiptDeps = {
  /** Defaults to NEXT_PUBLIC_QDIT_INTEGRATION === "1". */
  enabled?: boolean;
  /** The heading's current record (DoqtriRegistry.readNode). */
  readNode: (docId: string, nodeId: string) => Promise<ChainNode | null>;
  /** milestone_proof.get_milestone_status (readMilestoneRecord). */
  readMilestone: (chain: ProjectChain, projectId: string, milestoneId: string) => Promise<MilestoneChainRead>;
  /** Recorded approvals of these milestones (qdit_milestone_approvals). */
  approvals: (milestoneIds: string[]) => Promise<ApprovalRow[]>;
  cache?: ReadCache;
  max?: number;
};

const cacheKey = (network: QditChainNetwork, ref: QditArtifactRef) =>
  `${network}|${ref.contractId}|${ref.projectId}|${ref.milestoneId}`;

/**
 * The receipts for `docId`, or null when there are none to show: the
 * integration is off, history could not be read, or no heading's latest
 * record names qdit. Null renders nothing, so the page is then exactly
 * what it was without the integration.
 */
export async function loadQditReceipts(
  docId: string,
  history: DocumentHistory | null,
  deps: ReceiptDeps,
): Promise<QditReceipts | null> {
  if (!(deps.enabled ?? process.env.NEXT_PUBLIC_QDIT_INTEGRATION === "1")) return null;
  // The chain cannot list a document's nodes; its history can.
  const candidates = (history?.nodes ?? []).filter((node) => node.tool === QDIT_TOOL);
  if (!history || candidates.length === 0) return null;

  const max = deps.max ?? MAX_RECEIPTS;
  const checked = candidates.slice(0, max);
  const cache = deps.cache ?? receiptReadCache;

  const one = async (latest: ChainNodeEvent): Promise<QditReceipt | null> => {
    // The record as the contract holds it now; the history's latest write
    // stands in for it when the contract can't be asked.
    let record: ChainNode | ChainNodeEvent = latest;
    try {
      const current = await deps.readNode(docId, latest.nodeId);
      if (!current) return null;
      record = current;
    } catch {
      // Keep the history's.
    }
    if (record.tool !== QDIT_TOOL) return null;

    const base = {
      nodeId: latest.nodeId,
      record: { status: record.status, artifactRef: record.artifactRef },
      signing: signingEvent(history, latest.nodeId, record),
      approvalTxHash: null,
    };
    const ref = parseQditArtifactRef(record.artifactRef);
    if (!ref) return { ...base, ref: null, check: { state: "unreachable", reason: "invalid_ref" } };

    try {
      const read = await cache.get(cacheKey(ref.network, ref), () =>
        deps.readMilestone({ network: ref.network, contractId: ref.contractId }, ref.projectId, ref.milestoneId),
      );
      return { ...base, ref, check: checkReceipt(record, ref, read) };
    } catch (error) {
      const reason = error instanceof QditChainError && error.kind !== "unreachable" ? "contract" : "rpc";
      return { ...base, ref, check: { state: "unreachable", reason } };
    }
  };

  const receipts: QditReceipt[] = [];
  for (let i = 0; i < checked.length; i += CONCURRENCY) {
    for (const receipt of await Promise.all(checked.slice(i, i + CONCURRENCY).map(one))) {
      if (receipt) receipts.push(receipt);
    }
  }

  // One query for every approval the chain now shows.
  const approved = receipts.filter((r) => r.ref && r.check.state !== "unreachable" && r.check.chain?.status === "Approved");
  if (approved.length > 0) {
    let rows: ApprovalRow[] = [];
    try {
      rows = await deps.approvals([...new Set(approved.map((r) => r.ref!.milestoneId))]);
    } catch {
      // The receipt links to the contract instead.
    }
    for (const receipt of approved) {
      const { ref, check } = receipt;
      const version = check.state === "unreachable" ? null : check.chain?.version;
      const row = rows.find(
        (r) =>
          r.network === ref!.network &&
          r.contract_id === ref!.contractId &&
          r.project_id === ref!.projectId &&
          r.milestone_id === ref!.milestoneId &&
          Number(r.version) === version,
      );
      receipt.approvalTxHash = row?.tx_hash ?? null;
    }
  }

  if (receipts.length === 0 && candidates.length <= max) return null;
  return { receipts, more: candidates.length - checked.length };
}

/** stellar.expert's page for a transaction or contract on a qdit network (`public` is its mainnet slug). */
export function qditExplorerUrl(network: QditChainNetwork, kind: "tx" | "contract", id: string): string {
  return `https://stellar.expert/explorer/${network === "mainnet" ? "public" : "testnet"}/${kind}/${id}`;
}
