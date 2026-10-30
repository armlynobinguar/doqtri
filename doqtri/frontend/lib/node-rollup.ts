import type { MindmapNode } from "@/lib/mindmap";
import { NODE_STATUSES, type NodeStatus } from "@/lib/stellar/types";

/**
 * Parent headings that take their status from their children (WP-2.8,
 * D-24; docs/integration/CONTRACT.md section 11). Pure and browser-safe.
 *
 * A heading with no link of its own and at least one child heading rolls
 * up: all children Verified is Verified; else all Built or Verified is Built;
 * else any Building (a rejected milestone included) is Building; else
 * Planned. A child counts with its own on-chain record, or its own roll-up,
 * and Planned without either. A linked heading never rolls up: it carries
 * its own link's status.
 *
 * Roll-ups are signed like any other node status, by an editor, with
 * `tool = "rollup"` and `artifact_ref = "children:<ids>"` naming the direct
 * children in document order (section 10), so a third party can recompute
 * them from those children's own records. Every write is a fee the relayer
 * pays (R-04), so they ride in the same registry `anchor` call as the
 * statuses that changed them, at most 32 to a call, and nothing is written
 * that the ledger already says: an unchanged roll-up, or a Planned one where
 * there is no record yet (no record already reads as Planned).
 *
 * A parent whose current record has any tool other than exactly "rollup"
 * (signed by hand, "Mark mindmap done" on the root, or a qdit record left
 * from a link since removed) is attested (D-70): it is left as signed, since
 * a roll-up never overwrites a person's attestation, and it counts with that
 * record for its own parent (section 11).
 */

export const ROLLUP_TOOL = "rollup";

/** DoqtriRegistry's MAX_NODES_PER_CALL: node updates one `anchor` call takes. */
export const MAX_NODES_PER_ANCHOR = 32;

/** A node's on-chain record, as much as the roll-up reads. */
export type RecordLike = { status: string; tool: string; artifactRef: string };

export type NodeUpdate = { nodeId: string; status: NodeStatus; tool: string; artifactRef: string };

const KNOWN = new Set<string>(NODE_STATUSES);

function asStatus(status: string | null | undefined): NodeStatus {
  return status != null && KNOWN.has(status) ? (status as NodeStatus) : "Planned";
}

/** D-24, for a non-empty list of children's statuses. */
export function rollupOf(children: NodeStatus[]): NodeStatus {
  if (children.length > 0 && children.every((s) => s === "Verified")) return "Verified";
  if (children.length > 0 && children.every((s) => s === "Built" || s === "Verified")) return "Built";
  if (children.some((s) => s === "Building")) return "Building";
  return "Planned";
}

/** `children:h3,h4,h7` (section 10, D-24). */
export function rollupRef(childIds: string[]): string {
  return `children:${childIds.join(",")}`;
}

export type RollupPlan = {
  /** Roll-up writes the ledger needs, children before parents. */
  updates: NodeUpdate[];
  /** Every node's status once `pending` and `updates` land. */
  statuses: Record<string, NodeStatus>;
  /** Parents that would roll up but were signed by hand, so stay as they are. */
  keptByHand: string[];
};

/**
 * The roll-up writes for `tree`, given each node's current on-chain record
 * (`records`, missing or null for none), the nodes with a link of their own
 * (any provider, D-08) and the writes about to be signed for linked nodes
 * (`pending`), which count in place of their records.
 */
export function planRollups(params: {
  tree: MindmapNode;
  records: Record<string, RecordLike | null | undefined>;
  linked: Iterable<string>;
  pending?: NodeUpdate[];
}): RollupPlan {
  const linked = new Set(params.linked);
  const pending = new Map((params.pending ?? []).map((u) => [u.nodeId, u.status]));
  const updates: NodeUpdate[] = [];
  const statuses: Record<string, NodeStatus> = {};
  const keptByHand: string[] = [];

  const visit = (node: MindmapNode): NodeStatus => {
    // Children first, so a parent sees its children's final statuses and the
    // writes come out bottom-up.
    const childStatuses = node.children.map(visit);
    const record = params.records[node.id] ?? null;
    let status: NodeStatus;
    if (pending.has(node.id)) {
      status = pending.get(node.id)!;
    } else if (linked.has(node.id) || node.children.length === 0) {
      status = asStatus(record?.status);
    } else if (record && record.tool !== ROLLUP_TOOL) {
      keptByHand.push(node.id);
      status = asStatus(record.status);
    } else {
      status = rollupOf(childStatuses);
      const artifactRef = rollupRef(node.children.map((c) => c.id));
      const unchanged = record
        ? record.status === status && record.artifactRef === artifactRef
        : status === "Planned";
      if (!unchanged) updates.push({ nodeId: node.id, status, tool: ROLLUP_TOOL, artifactRef });
    }
    statuses[node.id] = status;
    return status;
  };
  visit(params.tree);

  return { updates, statuses, keptByHand };
}

/**
 * Splits node writes into `anchor` calls of at most `max` (R-04): one call,
 * so one signature, whenever they fit. Order is kept, so each call lands
 * children before the parents that roll up from them.
 */
export function anchorBatches(updates: NodeUpdate[], max: number = MAX_NODES_PER_ANCHOR): NodeUpdate[][] {
  const batches: NodeUpdate[][] = [];
  for (let i = 0; i < updates.length; i += max) batches.push(updates.slice(i, i + max));
  return batches;
}
