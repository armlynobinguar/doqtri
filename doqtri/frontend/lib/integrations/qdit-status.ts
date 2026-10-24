import {
  nodeStatusForMilestone,
  qditArtifactRef,
  QDIT_TOOL,
  type MilestoneChainStatus,
  type QditChainNetwork,
} from "@/lib/integrations/qdit-chain";
import type { QditMilestoneStatus } from "@/lib/integrations/qdit-client";
import type { MindmapNode } from "@/lib/mindmap";
import type { QditLinkRow } from "@/lib/node-links";
import { anchorBatches, planRollups, type NodeUpdate, type RecordLike } from "@/lib/node-rollup";
import type { NodeStatus } from "@/lib/stellar/types";

/**
 * What the ship panel suggests for a heading linked to a qdit milestone
 * (WP-2.8). Pure and browser-safe.
 *
 * The suggestion comes from the chain only (D-04, section 10): the last
 * read of the milestone's milestone_proof record, kept in
 * qdit_milestone_states by the webhook and the panel's re-check. qdit's own
 * status is shown beside it as a preview, never suggested from. The status
 * is the D-19 mapping, `tool = "qdit"`, and the artifact_ref names the
 * record's version, so a heading whose record already says exactly that is
 * up to date. Editors sign the suggestion with their own wallet (D-14);
 * viewers see it and no button.
 */

export type QditChainStateStatus = "unregistered" | "none" | MilestoneChainStatus;

/** A qdit_milestone_states row. */
export type QditMilestoneStateRow = {
  milestone_id: string;
  project_id: string;
  qdit_status: QditMilestoneStatus | null;
  qdit_status_at: string | null;
  chain_status: QditChainStateStatus | null;
  chain_network: QditChainNetwork | null;
  chain_contract_id: string | null;
  chain_version: number | null;
  chain_ledger: number | null;
  chain_checked_at: string | null;
  qdit_checked_at: string | null;
};

export const QDIT_MILESTONE_STATE_COLUMNS =
  "milestone_id, project_id, qdit_status, qdit_status_at, chain_status, chain_network, chain_contract_id, chain_version, chain_ledger, chain_checked_at, qdit_checked_at";

export type QditSuggestion =
  /** The record differs from what the chain says: an editor may sign `update`. */
  | { kind: "sign"; update: NodeUpdate; reason: string; preview: string | null }
  /** The heading's record already says it, or there is nothing to say yet beyond Planned. */
  | { kind: "current"; status: NodeStatus; reason: string; preview: string | null }
  /** Nothing to sign: unchecked, not on chain, or the link needs fixing first. */
  | { kind: "none"; status: NodeStatus | null; reason: string; preview: string | null };

const CHAIN_NAME: Record<QditMilestoneStatus, MilestoneChainStatus> = {
  proposed: "Proposed",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

/** qdit's word, when it is ahead of (or behind) the chain: "qdit says approved". */
function previewOf(state: QditMilestoneStateRow): string | null {
  if (!state.qdit_status || !state.chain_status || state.chain_status === "unregistered") return null;
  const chainSays = state.chain_status === "none" ? null : state.chain_status;
  if (CHAIN_NAME[state.qdit_status] === chainSays) return null;
  return `qdit says ${state.qdit_status}; Stellar doesn't show that yet.`;
}

export function suggestQditStatus(params: {
  link: Pick<QditLinkRow, "qdit_state" | "qdit_project_id" | "qdit_milestone_id" | "node_id">;
  state: QditMilestoneStateRow | null | undefined;
  /** The heading's own on-chain record now, or null for none. */
  record: RecordLike | null;
  /** The heading's record could not be read: `record` says nothing then. */
  recordUnread?: boolean;
}): QditSuggestion {
  const { link, state, record } = params;
  if (link.qdit_state === "ambiguous" || link.qdit_state === "broken" || link.qdit_state === "conflict") {
    return { kind: "none", status: null, reason: "Fix the link first; nothing is suggested until then.", preview: null };
  }
  if (!state?.chain_status) {
    return { kind: "none", status: null, reason: "Not checked on Stellar yet.", preview: null };
  }
  const preview = previewOf(state);
  if (state.chain_status === "unregistered") {
    return {
      kind: "none",
      status: "Planned",
      reason: "The qdit project isn't on Stellar yet, so the heading stays Planned.",
      preview,
    };
  }
  if (state.chain_status === "none") {
    // Section 10: a milestone with no record is not signed with tool = "qdit".
    return { kind: "none", status: "Planned", reason: "No proof is on Stellar for this milestone yet.", preview };
  }

  if (params.recordUnread) {
    // Not "no record": a failed read must not suggest what the heading may already say.
    return { kind: "none", status: null, reason: "This heading's record on Stellar couldn't be read.", preview };
  }

  const status = nodeStatusForMilestone(state.chain_status);
  let artifactRef: string;
  try {
    artifactRef = qditArtifactRef({
      network: state.chain_network!,
      contractId: state.chain_contract_id!,
      projectId: link.qdit_project_id,
      milestoneId: link.qdit_milestone_id,
      version: state.chain_version!,
    });
  } catch {
    return { kind: "none", status: null, reason: "This milestone can't be named on Stellar.", preview };
  }
  const said = `${state.chain_status} on Stellar (v${state.chain_version})`;
  const matches =
    record != null
      ? record.tool === QDIT_TOOL && record.status === status && record.artifactRef === artifactRef
      : status === "Planned";
  if (matches) return { kind: "current", status, reason: `Up to date: ${said}.`, preview };
  return {
    kind: "sign",
    update: { nodeId: link.node_id, status, tool: QDIT_TOOL, artifactRef },
    reason: `${said}.`,
    preview,
  };
}

export type QditSignPlan =
  | { ok: true; updates: NodeUpdate[]; rollups: NodeUpdate[]; batches: NodeUpdate[][] }
  | { ok: false; reason: "unread" | "nothing"; message: string };

/**
 * What one "Mark <status>" signs, from reads made just before (D-04): the
 * picked links' suggestions, every parent heading that rolls up from them
 * (section 11) and the anchor calls they fit in (R-04). Refuses when any
 * read it rests on failed, whether a heading's record (`unreadNodes`: a
 * failed read is not "no record", and would let a roll-up overwrite a
 * signed heading or downgrade a parent) or a picked milestone's chain read
 * (`unreadMilestones`: the stored state could be out of date).
 */
export function planQditSignature(params: {
  tree: MindmapNode;
  /** The note's qdit links as the save left them. */
  rows: QditLinkRow[];
  linkIds: string[];
  states: Record<string, QditMilestoneStateRow>;
  records: Record<string, RecordLike | null>;
  unreadNodes: string[];
  unreadMilestones: string[];
  /** Headings linked by another provider. */
  otherLinked: string[];
}): QditSignPlan {
  const picked = params.rows.filter((r) => params.linkIds.includes(r.id));
  if (params.unreadNodes.length > 0 || picked.some((r) => params.unreadMilestones.includes(r.qdit_milestone_id))) {
    return {
      ok: false,
      reason: "unread",
      message: "Stellar couldn't be read just now, so nothing was signed. Try again in a moment.",
    };
  }
  const updates: NodeUpdate[] = [];
  for (const row of picked) {
    const s = suggestQditStatus({ link: row, state: params.states[row.qdit_milestone_id], record: params.records[row.node_id] ?? null });
    if (s.kind === "sign") updates.push(s.update);
  }
  if (updates.length === 0) return { ok: false, reason: "nothing", message: "Nothing to sign: Stellar already says this." };
  const rollups = planRollups({
    tree: params.tree,
    records: params.records,
    linked: [...params.rows.map((r) => r.node_id), ...params.otherLinked],
    pending: updates,
  }).updates;
  return { ok: true, updates, rollups, batches: anchorBatches([...updates, ...rollups]) };
}
