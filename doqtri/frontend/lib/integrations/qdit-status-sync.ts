import { createHmac, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isProjectChain,
  QditChainError,
  readMilestoneRecord,
  type MilestoneChainRead,
  type MilestoneChainStatus,
  type ProjectChain,
  type QditChainNetwork,
} from "@/lib/integrations/qdit-chain";
import type { RecordApproval } from "@/lib/integrations/qdit-approvals";
import { QditError, type QditClient, type QditMilestoneStatus } from "@/lib/integrations/qdit-client";
import { QDIT_MILESTONE_STATE_COLUMNS, type QditMilestoneStateRow } from "@/lib/integrations/qdit-status";

/**
 * Keeping doqtri's picture of linked qdit milestones current (WP-2.8;
 * server-only). docs/integration/CONTRACT.md is the reference; section
 * numbers point into it.
 *
 * Two ways in, both ending in the same place, a chain read recorded with
 * record_qdit_milestone_state() (20261025120000_qdit_webhook_events.sql):
 *
 *   handleQditWebhook   qdit's signed `milestone.status_changed` (section 9),
 *                       checked in the contract's order: raw body, timestamp,
 *                       signature in constant time, JSON, idempotency by
 *                       event id, unknown events and unlinked milestones
 *                       acknowledged and dropped, then the chain is read.
 *   recheckDocStatuses  the ship panel opening (R-09): every linked
 *                       milestone of the note read from the chain again, and
 *                       from qdit's API as the user, so a missed, late or
 *                       duplicated webhook is put right.
 *
 * Neither signs anything or touches the chain beyond reading it (D-04, D-05):
 * an editor signs in the browser, with their own wallet (D-14).
 *
 * When a read finds a milestone Approved, both also hand it to
 * `recordApproval` (WP-3.1, lib/integrations/qdit-approvals.ts), which looks
 * the approving transaction up in RPC's event window for the public
 * receipts unless it has it already (or missed it within the hour, or for
 * longer than the window). That is best effort and never changes either
 * one's answer; the re-check route defers it past its response.
 */

export const QDIT_WEBHOOK_EVENT = "milestone.status_changed";
/** Section 9, step 2: seconds either side of doqtri's clock. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Section 4: bodies are at most 64 KiB. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MILESTONE_STATUSES: readonly QditMilestoneStatus[] = ["proposed", "submitted", "approved", "rejected"];

// ---------------------------------------------------------------------------
// Signature (section 9, steps 1 to 3)
// ---------------------------------------------------------------------------

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "timestamp_missing" | "timestamp_invalid" | "timestamp_stale" | "signature_mismatch" };

/**
 * Whether `signature` (the X-Qdit-Signature header: one or more
 * comma-separated `sha256=<hex>`, any one of which may match during secret
 * rotation) is HMAC-SHA256, keyed with the UTF-8 bytes of `secret`, over
 * `<timestamp>.<raw body bytes>`, and `timestamp` (X-Qdit-Timestamp, whole
 * Unix seconds) is within five minutes of `nowSeconds`.
 */
export function verifyWebhookSignature(params: {
  rawBody: Uint8Array;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowSeconds: number;
}): SignatureCheck {
  const { rawBody, timestamp, signature, secret, nowSeconds } = params;
  if (timestamp === null || timestamp.trim() === "") return { ok: false, reason: "timestamp_missing" };
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: "timestamp_invalid" };
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_stale" };
  }

  const expected = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(`${timestamp}.`, "utf8"))
    .update(rawBody)
    .digest();
  let matched = false;
  for (const part of (signature ?? "").split(",")) {
    const m = /^sha256=([0-9a-fA-F]{64})$/.exec(part.trim());
    if (!m) continue;
    // Both are 32 bytes, so the comparison takes the same time whatever they hold.
    if (timingSafeEqual(expected, Buffer.from(m[1], "hex"))) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

// ---------------------------------------------------------------------------
// The event (section 9, steps 4 and 6)
// ---------------------------------------------------------------------------

export type WebhookEvent = {
  id: string;
  event: typeof QDIT_WEBHOOK_EVENT;
  projectId: string;
  milestoneId: string;
  /** qdit's status in the body: a preview, never trusted (D-04, D-25). */
  status: QditMilestoneStatus;
  occurredAt: string;
};

export type ParsedWebhook =
  | { kind: "event"; event: WebhookEvent }
  /** Another event type: acknowledged and dropped (section 3). */
  | { kind: "unknown"; event: string | null }
  | { kind: "invalid"; reason: string };

export function parseWebhookEvent(rawBody: Uint8Array): ParsedWebhook {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return { kind: "invalid", reason: "The body is not valid JSON." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "invalid", reason: "The body is not a JSON object." };
  }
  const b = body as Record<string, unknown>;
  if (b.event !== QDIT_WEBHOOK_EVENT) return { kind: "unknown", event: typeof b.event === "string" ? b.event : null };

  const id = typeof b.id === "string" && UUID.test(b.id) ? b.id.toLowerCase() : null;
  const projectId = typeof b.project_id === "string" && UUID.test(b.project_id) ? b.project_id.toLowerCase() : null;
  const milestoneId =
    typeof b.milestone_id === "string" && UUID.test(b.milestone_id) ? b.milestone_id.toLowerCase() : null;
  const status = MILESTONE_STATUSES.includes(b.status as QditMilestoneStatus) ? (b.status as QditMilestoneStatus) : null;
  const occurredAt =
    typeof b.occurred_at === "string" && !Number.isNaN(Date.parse(b.occurred_at)) ? b.occurred_at : null;
  if (!id || !projectId || !milestoneId || !status || !occurredAt) {
    return { kind: "invalid", reason: "The event is missing a field, or a field is malformed." };
  }
  return { kind: "event", event: { id, event: QDIT_WEBHOOK_EVENT, projectId, milestoneId, status, occurredAt } };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** What a chain read found, as record_qdit_milestone_state() takes it. */
export type ChainState =
  | { status: "unregistered" }
  | {
      status: "none" | MilestoneChainStatus;
      network: QditChainNetwork;
      contractId: string;
      version: number | null;
      ledger: number;
    };

export type StateInput = {
  projectId: string;
  milestoneId: string;
  qditStatus?: { status: QditMilestoneStatus; at: string };
  chain?: ChainState;
  /** Stamp qdit_checked_at: qdit's API was just asked. */
  qditChecked?: boolean;
  /** The webhook event this acts on, marked done with it. */
  eventId?: string;
};

export type DocLinks = {
  project: { projectId: string; chain: ProjectChain | null } | null;
  links: { milestoneId: string; projectId: string }[];
  states: Record<string, QditMilestoneStateRow>;
};

export type StatusStore = {
  /** The project's chain if a heading links the milestone in that project, else `linked: false`. */
  linkedMilestone(projectId: string, milestoneId: string): Promise<{ linked: false } | { linked: true; chain: ProjectChain | null }>;
  claimEvent(event: WebhookEvent): Promise<"new" | "retry" | "done">;
  record(input: StateInput): Promise<"recorded" | "unlinked">;
  loadDoc(docId: string): Promise<DocLinks>;
  setProjectChain(docId: string, projectId: string, chain: ProjectChain | null): Promise<void>;
};

function chainOf(row: { chain_network?: unknown; chain_contract_id?: unknown } | null): ProjectChain | null {
  const chain = row ? { network: row.chain_network, contractId: row.chain_contract_id } : null;
  return isProjectChain(chain) ? chain : null;
}

/** The store over the service-role client: the webhook and re-check write nothing else. */
export function supabaseStatusStore(admin: SupabaseClient): StatusStore {
  const fail = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };

  return {
    async linkedMilestone(projectId, milestoneId) {
      const { data: link, error } = await admin
        .from("node_links")
        .select("document_id")
        .eq("provider", "qdit")
        .eq("qdit_project_id", projectId)
        .eq("qdit_milestone_id", milestoneId)
        .maybeSingle();
      fail("Could not read the milestone's link", error);
      if (!link) return { linked: false };
      const { data: project, error: projectError } = await admin
        .from("doc_project_links")
        .select("chain_network, chain_contract_id")
        .eq("document_id", (link as { document_id: string }).document_id)
        .maybeSingle();
      fail("Could not read the note's qdit project", projectError);
      return { linked: true, chain: chainOf(project) };
    },

    async claimEvent(event) {
      const { data, error } = await admin.rpc("claim_qdit_webhook_event", {
        p_id: event.id,
        p_event: event.event,
        p_project_id: event.projectId,
        p_milestone_id: event.milestoneId,
        p_status: event.status,
        p_occurred_at: event.occurredAt,
      });
      fail("Could not record the webhook event", error);
      if (data !== "new" && data !== "retry" && data !== "done") throw new Error("Unexpected claim result");
      return data;
    },

    async record(input) {
      const chain = input.chain;
      const { data, error } = await admin.rpc("record_qdit_milestone_state", {
        p_project_id: input.projectId,
        p_milestone_id: input.milestoneId,
        p_qdit_status: input.qditStatus?.status ?? null,
        p_qdit_status_at: input.qditStatus?.at ?? null,
        p_chain_status: chain?.status ?? null,
        p_chain_network: chain && chain.status !== "unregistered" ? chain.network : null,
        p_chain_contract_id: chain && chain.status !== "unregistered" ? chain.contractId : null,
        p_chain_version: chain && chain.status !== "unregistered" ? chain.version : null,
        p_chain_ledger: chain && chain.status !== "unregistered" ? chain.ledger : null,
        p_qdit_checked: input.qditChecked ?? false,
        p_event_id: input.eventId ?? null,
      });
      fail("Could not record the milestone's state", error);
      return data === "unlinked" ? "unlinked" : "recorded";
    },

    async loadDoc(docId) {
      const [projectRes, linksRes] = await Promise.all([
        admin
          .from("doc_project_links")
          .select("project_id, chain_network, chain_contract_id")
          .eq("document_id", docId)
          .maybeSingle(),
        admin
          .from("node_links")
          .select("qdit_milestone_id, qdit_project_id")
          .eq("document_id", docId)
          .eq("provider", "qdit"),
      ]);
      fail("Could not read the note's qdit project", projectRes.error);
      fail("Could not read the note's qdit links", linksRes.error);
      const rows = (linksRes.data ?? []) as { qdit_milestone_id: string; qdit_project_id: string }[];
      const links = rows.map((r) => ({ milestoneId: r.qdit_milestone_id, projectId: r.qdit_project_id }));
      const states: Record<string, QditMilestoneStateRow> = {};
      if (links.length > 0) {
        const { data, error } = await admin
          .from("qdit_milestone_states")
          .select(QDIT_MILESTONE_STATE_COLUMNS)
          .in(
            "milestone_id",
            links.map((l) => l.milestoneId),
          );
        fail("Could not read the milestones' states", error);
        for (const row of (data ?? []) as QditMilestoneStateRow[]) states[row.milestone_id] = row;
      }
      const project = projectRes.data as { project_id: string; chain_network: unknown; chain_contract_id: unknown } | null;
      return {
        project: project ? { projectId: project.project_id, chain: chainOf(project) } : null,
        links,
        states,
      };
    },

    async setProjectChain(docId, projectId, chain) {
      const { error } = await admin
        .from("doc_project_links")
        .update({ chain_network: chain?.network ?? null, chain_contract_id: chain?.contractId ?? null })
        .eq("document_id", docId)
        .eq("project_id", projectId);
      fail("Could not record the project's chain", error);
    },
  };
}

// ---------------------------------------------------------------------------
// Reading the chain
// ---------------------------------------------------------------------------

export type ReadChain = (chain: ProjectChain, projectId: string, milestoneId: string) => Promise<MilestoneChainRead>;

export const readChainOverRpc: ReadChain = (chain, projectId, milestoneId) =>
  readMilestoneRecord(chain, projectId, milestoneId);

/** The milestone's record on its project's chain, now, as the store records it. */
export async function chainStateFor(
  chain: ProjectChain | null,
  projectId: string,
  milestoneId: string,
  readChain: ReadChain,
): Promise<ChainState> {
  if (!chain) return { status: "unregistered" };
  const read = await readChain(chain, projectId, milestoneId);
  return {
    status: read.record?.status ?? "none",
    network: chain.network,
    contractId: chain.contractId,
    version: read.record?.version ?? null,
    ledger: read.ledger,
  };
}

/** The approval a chain read shows, as qdit_milestone_approvals keys it; null unless Approved. */
function approvalKeyOf(chain: ChainState, projectId: string, milestoneId: string) {
  if (chain.status !== "Approved" || chain.version === null) return null;
  return { network: chain.network, contractId: chain.contractId, projectId, milestoneId, version: chain.version };
}

/** Hands an approval to `record`, which should not throw; if it does, nothing else is affected. */
async function noteApproval(record: RecordApproval | undefined, key: ReturnType<typeof approvalKeyOf>) {
  if (!record || !key) return;
  try {
    await record(key);
  } catch {
    // The receipt links to the contract instead.
  }
}

// ---------------------------------------------------------------------------
// The webhook (section 9)
// ---------------------------------------------------------------------------

export type WebhookResult = { status: number; body: Record<string, unknown> };

/**
 * One delivery, in the contract's order. 2xx tells qdit it is delivered;
 * 401, 400 and 413 are qdit's problem to look at; 503 (the chain could not
 * be read, or doqtri's database failed) asks qdit to retry, which acts on the
 * event again since it was never marked done.
 */
export async function handleQditWebhook(params: {
  rawBody: Uint8Array;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowMs: number;
  store: StatusStore;
  readChain: ReadChain;
  /** WP-3.1: called when the read shows the milestone Approved. */
  recordApproval?: RecordApproval;
}): Promise<WebhookResult> {
  const { rawBody, store } = params;
  if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) return { status: 413, body: { error: "Body too large" } };

  const check = verifyWebhookSignature({
    rawBody,
    timestamp: params.timestamp,
    signature: params.signature,
    secret: params.secret,
    nowSeconds: Math.floor(params.nowMs / 1000),
  });
  if (!check.ok) {
    return {
      status: 401,
      body: { error: check.reason === "signature_mismatch" ? "Invalid signature" : "Invalid or stale timestamp" },
    };
  }

  const parsed = parseWebhookEvent(rawBody);
  if (parsed.kind === "invalid") return { status: 400, body: { error: parsed.reason } };
  if (parsed.kind === "unknown") return { status: 200, body: { ok: true, ignored: "unknown_event" } };
  const { event } = parsed;

  try {
    const linked = await store.linkedMilestone(event.projectId, event.milestoneId);
    if (!linked.linked) return { status: 200, body: { ok: true, ignored: "unlinked" } };

    if ((await store.claimEvent(event)) === "done") return { status: 200, body: { ok: true, duplicate: true } };

    let chain: ChainState;
    try {
      chain = await chainStateFor(linked.chain, event.projectId, event.milestoneId, params.readChain);
    } catch (error) {
      if (error instanceof QditChainError && error.kind !== "unreachable") {
        // Retrying won't change an answer doqtri can't read: keep qdit's
        // word as a preview and let the panel's re-check report it.
        console.error(`[qdit-webhook] ${event.milestoneId}: ${error.message}`);
        await store.record({
          projectId: event.projectId,
          milestoneId: event.milestoneId,
          qditStatus: { status: event.status, at: event.occurredAt },
          eventId: event.id,
        });
        return { status: 200, body: { ok: true, chain: "unreadable" } };
      }
      return { status: 503, body: { error: "Stellar could not be read. Retry later." } };
    }

    const outcome = await store.record({
      projectId: event.projectId,
      milestoneId: event.milestoneId,
      qditStatus: { status: event.status, at: event.occurredAt },
      chain,
      eventId: event.id,
    });
    // An approval event is what makes qdit send this, so the approving
    // transaction is at the newest end of RPC's window now.
    if (outcome === "recorded") await noteApproval(params.recordApproval, approvalKeyOf(chain, event.projectId, event.milestoneId));
    return { status: 200, body: outcome === "unlinked" ? { ok: true, ignored: "unlinked" } : { ok: true } };
  } catch (error) {
    console.error(`[qdit-webhook] ${error instanceof Error ? error.message : String(error)}`);
    return { status: 503, body: { error: "Could not process the event. Retry later." } };
  }
}

// ---------------------------------------------------------------------------
// The re-check when the panel opens (R-09)
// ---------------------------------------------------------------------------

/** qdit's API is asked about a milestone at most this often, unless forced. */
export const QDIT_RECHECK_MS = 5 * 60_000;
/** A chain read this fresh is reused, unless forced. */
export const CHAIN_RECHECK_MS = 15_000;
/** Reads in flight at once. */
const CONCURRENCY = 4;

export type RecheckResult = {
  states: Record<string, QditMilestoneStateRow>;
  /** Short, safe to show; one per kind of failure. */
  errors: string[];
  /**
   * Milestones whose chain read failed on this call, so their state is the
   * last one stored. A signature waits for them (force reads every one).
   */
  unread: string[];
};

const age = (at: string | null | undefined, now: number) => (at ? now - Date.parse(at) : Infinity);

/**
 * Reads every linked milestone of the note again: from the chain, which is
 * what counts, and from qdit's API as the user when `client` is given
 * (their own project roles apply, D-23; a user without a qdit connection
 * still gets the chain). `force` (an editor about to sign) skips the
 * freshness windows, so a signature always follows a read made just before.
 */
export async function recheckDocStatuses(params: {
  store: StatusStore;
  client: QditClient | null;
  docId: string;
  readChain: ReadChain;
  force?: boolean;
  now?: () => number;
  /** WP-3.1: called whenever a read shows a milestone Approved. */
  recordApproval?: RecordApproval;
}): Promise<RecheckResult> {
  const { store, docId, readChain, force = false } = params;
  const now = params.now ?? Date.now;
  const errors = new Set<string>();
  const unread = new Set<string>();
  let client = params.client;

  /** Stops asking qdit when the user has no usable connection or qdit is busy. */
  const qditFailed = (error: unknown) => {
    if (error instanceof QditError && (error.kind === "not_connected" || error.kind === "rate_limited")) {
      client = null;
      if (error.kind === "rate_limited") errors.add("qdit is busy; showing what Stellar says.");
      return;
    }
    if (error instanceof QditError && error.kind === "not_found") {
      errors.add("qdit can't find a linked milestone, or you can no longer see it.");
      return;
    }
    errors.add("qdit couldn't be reached; showing what Stellar says.");
  };

  const doc = await store.loadDoc(docId);
  if (!doc.project || doc.links.length === 0) return { states: doc.states, errors: [], unread: [] };
  let chain = doc.project.chain;

  // The project's chain: needed once it is registered, and checked again
  // before a signature in case it moved.
  if (client && (chain === null || force)) {
    try {
      const project = (await client.listAllProjects()).find((p) => p.id === doc.project!.projectId);
      if (project) {
        const reported = project.chain ? { network: project.chain.network, contractId: project.chain.contract_id } : null;
        const next = isProjectChain(reported) ? reported : null;
        if (next?.network !== chain?.network || next?.contractId !== chain?.contractId) {
          await store.setProjectChain(docId, doc.project.projectId, next);
          chain = next;
        }
      }
    } catch (error) {
      qditFailed(error);
    }
  }

  const recheck = async (link: { milestoneId: string; projectId: string }) => {
    const state = doc.states[link.milestoneId];
    if (client && (force || age(state?.qdit_checked_at, now()) > QDIT_RECHECK_MS)) {
      try {
        const milestone = await client.getMilestone(link.milestoneId);
        if (milestone.project.id === link.projectId) {
          await store.record({
            ...link,
            qditStatus: { status: milestone.status, at: milestone.updated_at },
            qditChecked: true,
          });
        }
      } catch (error) {
        qditFailed(error);
      }
    }
    if (force || age(state?.chain_checked_at, now()) > CHAIN_RECHECK_MS) {
      try {
        const read = await chainStateFor(chain, link.projectId, link.milestoneId, readChain);
        await store.record({ ...link, chain: read });
        // On every read, not just the first that saw it: the webhook's own
        // lookup may have failed. recordApproval skips an approval it has,
        // missed within the last hour, or has missed for longer than RPC's
        // window; the route's recorder runs after the answer is sent.
        await noteApproval(params.recordApproval, approvalKeyOf(read, link.projectId, link.milestoneId));
      } catch (error) {
        unread.add(link.milestoneId);
        errors.add(
          error instanceof QditChainError && error.kind === "unreachable"
            ? "Stellar couldn't be reached; the statuses shown may be out of date."
            : "A milestone's record on Stellar couldn't be read.",
        );
      }
    }
  };

  for (let i = 0; i < doc.links.length; i += CONCURRENCY) {
    await Promise.all(doc.links.slice(i, i + CONCURRENCY).map(recheck));
  }

  return { states: (await store.loadDoc(docId)).states, errors: [...errors], unread: [...unread] };
}
