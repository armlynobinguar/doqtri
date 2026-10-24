import type { NodeStatus } from "@/lib/stellar/types";
import type { QditMilestoneStatus, QditNetwork } from "@/lib/integrations/qdit-client";

/**
 * What the qdit milestone card shows, and which state it is in (WP-2.6).
 * Pure and browser-safe (type-only imports), so every rule is unit tested
 * directly; the card is components/integrations/qdit-milestone-card.tsx and
 * its data comes from GET /api/integrations/qdit/milestones/[id], which asks
 * qdit as the signed-in user (docs/integration/CONTRACT.md section 8).
 *
 * The states, exactly as they are detected from the route's answer:
 *
 *   loaded         200 with a milestone.
 *   no-access      qdit answered 403 or 404 for this user (the route says
 *                  QDIT_NO_ACCESS). qdit's 404 never reveals whether the
 *                  milestone exists (section 6), so the card says the same
 *                  thing for both and nothing about the milestone.
 *   not-connected  the user has no qdit connection, or it expired or was
 *                  revoked (QDIT_NOT_CONNECTED): connect or reconnect.
 *
 * Anything else (qdit down, rate limited, this deployment not set up) is
 * `error`, with a retry; `loading` is the wait before the first answer.
 *
 * Status is qdit's off-chain `milestone_status`, a preview: it can differ
 * from the chain (section 7), and doqtri suggests a node status only from
 * `milestone_proof` (D-04, D-19). The card says which node status it maps to
 * so the two vocabularies line up, and nothing signs from it.
 */

/** The fields the card shows: a subset of the contract's Milestone, nothing else forwarded. */
export type MilestonePreview = {
  id: string;
  title: string;
  /** Null for a value this version of doqtri does not know. */
  status: QditMilestoneStatus | null;
  due_date: string | null;
  /** qdit's page for the milestone, only when it is an http(s) URL. */
  url: string | null;
  project: { id: string; name: string; slug: string };
  /** The heading qdit has the milestone linked to, or null when it is unlinked. */
  node: { id: string; label: string } | null;
  anchor: {
    network: QditNetwork;
    version: number;
    last_action: "submit" | "approve" | "reject";
    last_tx_hash: string;
    anchored_at: string;
  } | null;
  updated_at: string;
};

export type QditConnectionProblem = "none" | "needs_reconnect";

export type MilestoneCardState =
  | { state: "loading" }
  | { state: "loaded"; milestone: MilestonePreview }
  | { state: "no_access" }
  | { state: "not_connected"; connection: QditConnectionProblem }
  | { state: "error"; message: string; retryAfterSeconds: number | null };

/** The route's codes the card branches on (never on the message). */
export const MILESTONE_CODES = {
  noAccess: "QDIT_NO_ACCESS",
  notConnected: "QDIT_NOT_CONNECTED",
} as const;

export const NO_ACCESS_TEXT = "You don't have access to this milestone in qdit";

/** D-19, qdit's column to doqtri's (CONTRACT.md section 10). */
export const NODE_STATUS_FOR: Record<QditMilestoneStatus, NodeStatus> = {
  proposed: "Planned",
  submitted: "Built",
  approved: "Verified",
  rejected: "Building",
};

export const QDIT_STATUS_LABEL: Record<QditMilestoneStatus, string> = {
  proposed: "Proposed",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

export const QDIT_STATUS_TONE: Record<QditMilestoneStatus, "planned" | "info" | "verified" | "danger"> = {
  proposed: "planned",
  submitted: "info",
  approved: "verified",
  rejected: "danger",
};

const STATUSES = new Set<string>(Object.keys(NODE_STATUS_FOR));
const ACTIONS = new Set(["submit", "approve", "reject"]);
const ACTION_LABEL = { submit: "Submitted", approve: "Approved", reject: "Rejected" } as const;

const isString = (v: unknown): v is string => typeof v === "string";
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** An http(s) URL, or null: nothing else becomes an href. */
export function safeHttpUrl(value: unknown): string | null {
  if (!isString(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The preview of a Milestone as qdit sent it, or null when it lacks what the
 * card needs. Unknown fields are dropped (section 3), and so are the fields
 * the card does not show.
 */
export function toMilestonePreview(raw: unknown): MilestonePreview | null {
  const m = obj(raw);
  const project = obj(m?.project);
  if (!m || !project || !isString(m.id) || !isString(m.title) || !isString(project.id) || !isString(project.name)) {
    return null;
  }
  const link = obj(m.link);
  const anchor = obj(m.anchor);
  const network = anchor?.network === "mainnet" || anchor?.network === "testnet" ? anchor.network : null;
  return {
    id: m.id,
    title: m.title,
    status: isString(m.status) && STATUSES.has(m.status) ? (m.status as QditMilestoneStatus) : null,
    due_date: isString(m.due_date) && /^\d{4}-\d{2}-\d{2}$/.test(m.due_date) ? m.due_date : null,
    url: safeHttpUrl(m.url),
    project: { id: project.id, name: project.name, slug: isString(project.slug) ? project.slug : "" },
    node: link && isString(link.node_id) ? { id: link.node_id, label: isString(link.node_label) ? link.node_label : "" } : null,
    anchor:
      anchor &&
      network &&
      typeof anchor.version === "number" &&
      isString(anchor.last_action) &&
      ACTIONS.has(anchor.last_action) &&
      isString(anchor.last_tx_hash) &&
      /^[0-9a-f]{64}$/i.test(anchor.last_tx_hash) &&
      isString(anchor.anchored_at)
        ? {
            network,
            version: anchor.version,
            last_action: anchor.last_action as "submit" | "approve" | "reject",
            last_tx_hash: anchor.last_tx_hash.toLowerCase(),
            anchored_at: anchor.anchored_at,
          }
        : null,
    updated_at: isString(m.updated_at) ? m.updated_at : "",
  };
}

/** The card's state for the route's answer: its HTTP status, JSON body and Retry-After. */
export function cardStateFromResponse(
  status: number,
  body: unknown,
  retryAfter: string | null = null,
): MilestoneCardState {
  const b = obj(body);
  if (status === 200) {
    const milestone = toMilestonePreview(b?.milestone);
    return milestone
      ? { state: "loaded", milestone }
      : { state: "error", message: "qdit sent a milestone Doqtri could not read.", retryAfterSeconds: null };
  }
  const code = isString(b?.code) ? b.code : null;
  if (code === MILESTONE_CODES.noAccess) return { state: "no_access" };
  if (code === MILESTONE_CODES.notConnected || status === 401) {
    // A signed-out doqtri session (401) has no usable connection either.
    return { state: "not_connected", connection: b?.connection === "needs_reconnect" ? "needs_reconnect" : "none" };
  }
  const seconds = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
  return {
    state: "error",
    message: isString(b?.error) && b.error ? b.error : "qdit couldn't be reached. Try again.",
    retryAfterSeconds: status === 429 ? seconds : null,
  };
}

/** "Approved on chain, v2": what the newest anchor record says. A pointer, not proof (D-04, D-32). */
export function anchorLabel(anchor: NonNullable<MilestonePreview["anchor"]>): string {
  return `${ACTION_LABEL[anchor.last_action]} on chain, v${anchor.version}`;
}

/** The explorer page for an anchor's transaction, on the anchor's own network. */
export function anchorTxUrl(anchor: NonNullable<MilestonePreview["anchor"]>): string {
  const network = anchor.network === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${network}/tx/${anchor.last_tx_hash}`;
}

/** A `YYYY-MM-DD` due date for display, without a timezone shifting it a day. */
export function formatDueDate(date: string, locale?: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(at.getTime())
    ? date
    : at.toLocaleDateString(locale, { dateStyle: "medium", timeZone: "UTC" });
}
