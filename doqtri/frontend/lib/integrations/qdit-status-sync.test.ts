import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QditChainError, type MilestoneChainRead, type ProjectChain } from "@/lib/integrations/qdit-chain";
import { QditError, QditNotConnectedError, type QditClient, type QditMilestone } from "@/lib/integrations/qdit-client";
import type { QditMilestoneStateRow } from "@/lib/integrations/qdit-status";
import {
  handleQditWebhook,
  parseWebhookEvent,
  recheckDocStatuses,
  verifyWebhookSignature,
  type ReadChain,
  type StateInput,
  type StatusStore,
  type WebhookEvent,
} from "@/lib/integrations/qdit-status-sync";

/*
 * qdit's status webhook and the panel's re-check (WP-2.8, contract section 9,
 * R-09). The store is in memory and keeps the same "newest wins" guards as
 * record_qdit_milestone_state() (tested in SQL on its own); the chain and
 * qdit's API are fakes.
 */

// The contract's worked example, byte for byte.
const SECRET = "whsec_example_do_not_use";
const TIMESTAMP = "1792843200";
const BODY =
  '{"id":"7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10","event":"milestone.status_changed","project_id":"3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34","milestone_id":"b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61","status":"approved","occurred_at":"2026-10-24T11:59:58.412Z"}';
const SIGNATURE = "sha256=2af3710d7ffbe0732e23e5d7e81b6e3350569bb189fd133681af78a2826e1bfe";
const NOW_MS = 1_792_843_200_000;

const PROJECT = "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34";
const MILESTONE = "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61";
const MILESTONE_2 = "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62";
const DOC = "30000000-0000-4000-8000-000000000001";
const CHAIN: ProjectChain = { network: "testnet", contractId: "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG" };

const bytes = (text: string) => new TextEncoder().encode(text);
const sign = (body: string, timestamp: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
const eventBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ...JSON.parse(BODY), ...overrides });

// ---------------------------------------------------------------------------
// An in-memory store
// ---------------------------------------------------------------------------

type MemoryStore = StatusStore & {
  events: Map<string, { processed: boolean; attempts: number }>;
  states: Map<string, QditMilestoneStateRow>;
  linked: Map<string, string>; // milestone -> project
  chain: ProjectChain | null;
  records: StateInput[];
};

function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    events: new Map(),
    states: new Map(),
    linked: new Map([
      [MILESTONE, PROJECT],
      [MILESTONE_2, PROJECT],
    ]),
    chain: CHAIN,
    records: [],
    async linkedMilestone(projectId, milestoneId) {
      return store.linked.get(milestoneId) === projectId ? { linked: true, chain: store.chain } : { linked: false };
    },
    async claimEvent(event: WebhookEvent) {
      const seen = store.events.get(event.id);
      if (!seen) {
        store.events.set(event.id, { processed: false, attempts: 1 });
        return "new";
      }
      seen.attempts += 1;
      return seen.processed ? "done" : "retry";
    },
    async record(input) {
      store.records.push(input);
      const done = () => {
        const e = input.eventId ? store.events.get(input.eventId) : undefined;
        if (e) e.processed = true;
      };
      if (store.linked.get(input.milestoneId) !== input.projectId) {
        done();
        return "unlinked";
      }
      const s: QditMilestoneStateRow = store.states.get(input.milestoneId) ?? {
        milestone_id: input.milestoneId,
        project_id: input.projectId,
        qdit_status: null,
        qdit_status_at: null,
        chain_status: null,
        chain_network: null,
        chain_contract_id: null,
        chain_version: null,
        chain_ledger: null,
        chain_checked_at: null,
        qdit_checked_at: null,
      };
      if (input.qditStatus && (!s.qdit_status_at || Date.parse(input.qditStatus.at) >= Date.parse(s.qdit_status_at))) {
        s.qdit_status = input.qditStatus.status;
        s.qdit_status_at = input.qditStatus.at;
      }
      const c = input.chain;
      if (c) {
        const ledger = c.status === "unregistered" ? null : c.ledger;
        if (s.chain_ledger === null || ledger === null || ledger >= s.chain_ledger) {
          s.chain_status = c.status;
          s.chain_network = c.status === "unregistered" ? null : c.network;
          s.chain_contract_id = c.status === "unregistered" ? null : c.contractId;
          s.chain_version = c.status === "unregistered" ? null : c.version;
          s.chain_ledger = ledger;
          s.chain_checked_at = new Date(NOW_MS).toISOString();
        }
      }
      if (input.qditChecked) s.qdit_checked_at = new Date(NOW_MS).toISOString();
      store.states.set(input.milestoneId, s);
      done();
      return "recorded";
    },
    async loadDoc() {
      return {
        project: { projectId: PROJECT, chain: store.chain },
        links: [...store.linked.entries()].map(([milestoneId, projectId]) => ({ milestoneId, projectId })),
        states: Object.fromEntries(store.states),
      };
    },
    async setProjectChain(_docId, _projectId, chain) {
      store.chain = chain;
    },
  };
  return store;
}

const approvedRead = (ledger = 900, version = 2): MilestoneChainRead => ({
  ledger,
  record: { status: "Approved", version, proofHash: "ab".repeat(32), submitter: "G", timestamp: 1 },
});

let store: MemoryStore;
let readChain: ReturnType<typeof vi.fn<ReadChain>>;

beforeEach(() => {
  store = memoryStore();
  readChain = vi.fn<ReadChain>(async () => approvedRead());
});

const deliver = (overrides: { body?: string; timestamp?: string | null; signature?: string | null; nowMs?: number } = {}) => {
  const body = overrides.body ?? BODY;
  const timestamp = overrides.timestamp === undefined ? TIMESTAMP : overrides.timestamp;
  return handleQditWebhook({
    rawBody: bytes(body),
    timestamp,
    signature:
      overrides.signature === undefined ? (body === BODY && timestamp === TIMESTAMP ? SIGNATURE : sign(body, timestamp ?? "")) : overrides.signature,
    secret: SECRET,
    nowMs: overrides.nowMs ?? NOW_MS,
    store,
    readChain,
  });
};

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature (section 9)", () => {
  const check = (p: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
    verifyWebhookSignature({
      rawBody: bytes(BODY),
      timestamp: TIMESTAMP,
      signature: SIGNATURE,
      secret: SECRET,
      nowSeconds: NOW_MS / 1000,
      ...p,
    });

  it("accepts the contract's worked example", () => {
    expect(check()).toEqual({ ok: true });
  });

  it("accepts a match on any one of several signatures (rotation)", () => {
    expect(check({ signature: `sha256=${"0".repeat(64)}, ${SIGNATURE}` })).toEqual({ ok: true });
    expect(check({ signature: `${SIGNATURE},sha256=${"0".repeat(64)}` })).toEqual({ ok: true });
  });

  it("refuses a wrong secret, a changed body, a changed timestamp or a garbled header", () => {
    expect(check({ secret: "whsec_other" })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(check({ rawBody: bytes(BODY.replace("approved", "rejected")) })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(check({ rawBody: bytes(`${BODY} `) })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(check({ timestamp: "1792843201", nowSeconds: 1792843201 })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(check({ signature: SIGNATURE.replace("sha256=", "sha1=") })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(check({ signature: SIGNATURE.slice(0, -2) })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(check({ signature: null })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("refuses a missing, malformed or stale timestamp, either side of the clock", () => {
    expect(check({ timestamp: null })).toEqual({ ok: false, reason: "timestamp_missing" });
    expect(check({ timestamp: "" })).toEqual({ ok: false, reason: "timestamp_missing" });
    expect(check({ timestamp: "1792843200.5" })).toEqual({ ok: false, reason: "timestamp_invalid" });
    expect(check({ timestamp: "-1" })).toEqual({ ok: false, reason: "timestamp_invalid" });
    expect(check({ nowSeconds: 1792843200 + 300 })).toEqual({ ok: true });
    expect(check({ nowSeconds: 1792843200 + 301 })).toEqual({ ok: false, reason: "timestamp_stale" });
    expect(check({ nowSeconds: 1792843200 - 301 })).toEqual({ ok: false, reason: "timestamp_stale" });
  });
});

describe("parseWebhookEvent", () => {
  it("reads the contract's body", () => {
    expect(parseWebhookEvent(bytes(BODY))).toEqual({
      kind: "event",
      event: {
        id: "7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10",
        event: "milestone.status_changed",
        projectId: PROJECT,
        milestoneId: MILESTONE,
        status: "approved",
        occurredAt: "2026-10-24T11:59:58.412Z",
      },
    });
  });

  it("tells unknown events from broken ones", () => {
    expect(parseWebhookEvent(bytes('{"id":"x","event":"milestone.deleted"}'))).toEqual({ kind: "unknown", event: "milestone.deleted" });
    expect(parseWebhookEvent(bytes("{nope"))).toMatchObject({ kind: "invalid" });
    expect(parseWebhookEvent(bytes("[]"))).toMatchObject({ kind: "invalid" });
    expect(parseWebhookEvent(new Uint8Array([0xff, 0xfe]))).toMatchObject({ kind: "invalid" });
    expect(parseWebhookEvent(bytes(eventBody({ status: "done" })))).toMatchObject({ kind: "invalid" });
    expect(parseWebhookEvent(bytes(eventBody({ milestone_id: "h1" })))).toMatchObject({ kind: "invalid" });
    expect(parseWebhookEvent(bytes(eventBody({ occurred_at: "yesterday" })))).toMatchObject({ kind: "invalid" });
  });
});

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

describe("handleQditWebhook", () => {
  it("reads the chain for a linked milestone and records what it says", async () => {
    expect(await deliver()).toEqual({ status: 200, body: { ok: true } });
    expect(readChain).toHaveBeenCalledWith(CHAIN, PROJECT, MILESTONE);
    expect(store.states.get(MILESTONE)).toMatchObject({
      qdit_status: "approved",
      chain_status: "Approved",
      chain_version: 2,
      chain_ledger: 900,
    });
    expect(store.events.get("7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10")).toEqual({ processed: true, attempts: 1 });
  });

  it("refuses bad signatures and stale timestamps with 401, before reading anything", async () => {
    expect((await deliver({ signature: sign(BODY, TIMESTAMP, "whsec_wrong") })).status).toBe(401);
    expect((await deliver({ nowMs: NOW_MS + 301_000 })).status).toBe(401);
    expect((await deliver({ timestamp: null })).status).toBe(401);
    expect((await deliver({ signature: null })).status).toBe(401);
    expect(store.events.size).toBe(0);
    expect(readChain).not.toHaveBeenCalled();
  });

  it("refuses a validly signed body that isn't JSON with 400", async () => {
    expect((await deliver({ body: "not json" })).status).toBe(400);
  });

  it("acts on an id once: a replay is answered and changes nothing", async () => {
    await deliver();
    readChain.mockResolvedValue({ ledger: 950, record: null });
    // qdit's retry: same id and bytes, fresh timestamp and signature.
    const retry = await deliver({ timestamp: "1792843260", nowMs: NOW_MS + 60_000 });
    expect(retry).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(readChain).toHaveBeenCalledTimes(1);
    expect(store.states.get(MILESTONE)?.chain_status).toBe("Approved");
  });

  it("refuses a replay of an old delivery whose timestamp has gone stale", async () => {
    await deliver();
    expect((await deliver({ nowMs: NOW_MS + 3_600_000 })).status).toBe(401);
  });

  it("asks qdit to retry when Stellar can't be read, and acts on the retry", async () => {
    readChain.mockRejectedValueOnce(new QditChainError("unreachable", "down"));
    expect((await deliver()).status).toBe(503);
    expect(store.events.get("7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10")?.processed).toBe(false);
    expect(await deliver({ timestamp: "1792843260", nowMs: NOW_MS + 60_000 })).toEqual({ status: 200, body: { ok: true } });
    expect(store.states.get(MILESTONE)?.chain_status).toBe("Approved");
  });

  it("does not retry an answer it can't read: keeps qdit's word and moves on", async () => {
    readChain.mockRejectedValueOnce(new QditChainError("bad_response", "garbled"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await deliver()).toEqual({ status: 200, body: { ok: true, chain: "unreadable" } });
    expect(store.states.get(MILESTONE)).toMatchObject({ qdit_status: "approved", chain_status: null });
    errors.mockRestore();
  });

  it("acknowledges and drops unknown events and unlinked milestones", async () => {
    const unknown = eventBody({ event: "milestone.deleted" });
    expect(await deliver({ body: unknown })).toEqual({ status: 200, body: { ok: true, ignored: "unknown_event" } });
    const unlinked = eventBody({ milestone_id: "c81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61" });
    expect(await deliver({ body: unlinked })).toEqual({ status: 200, body: { ok: true, ignored: "unlinked" } });
    const elsewhere = eventBody({ project_id: "4f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34" });
    expect(await deliver({ body: elsewhere })).toEqual({ status: 200, body: { ok: true, ignored: "unlinked" } });
    expect(readChain).not.toHaveBeenCalled();
    expect(store.records).toEqual([]);
  });

  it("records a project with no chain as unregistered, without a read", async () => {
    store.chain = null;
    expect((await deliver()).status).toBe(200);
    expect(readChain).not.toHaveBeenCalled();
    expect(store.states.get(MILESTONE)?.chain_status).toBe("unregistered");
  });

  it("keeps the newest state when events arrive out of order (D-25)", async () => {
    // The approval (newer) arrives first, its chain read at ledger 900.
    await deliver();
    // Then a late "submitted" event from before it, whose read raced and saw an older ledger.
    readChain.mockResolvedValueOnce({
      ledger: 880,
      record: { status: "Submitted", version: 2, proofHash: "ab".repeat(32), submitter: "G", timestamp: 1 },
    });
    const late = eventBody({ id: "8d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10", status: "submitted", occurred_at: "2026-10-24T11:00:00.000Z" });
    expect((await deliver({ body: late })).status).toBe(200);
    expect(store.states.get(MILESTONE)).toMatchObject({ qdit_status: "approved", chain_status: "Approved", chain_ledger: 900 });
    // And the body's status is never what decides: a stale "submitted" body read at a newer ledger records the chain.
    readChain.mockResolvedValueOnce(approvedRead(990));
    const stale = eventBody({ id: "9d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10", status: "submitted", occurred_at: "2026-10-24T11:30:00.000Z" });
    await deliver({ body: stale });
    expect(store.states.get(MILESTONE)).toMatchObject({ qdit_status: "approved", chain_status: "Approved", chain_ledger: 990 });
  });

  it("answers 503 when its own database fails, so qdit retries", async () => {
    store.claimEvent = async () => {
      throw new Error("db down");
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await deliver()).status).toBe(503);
    errors.mockRestore();
  });

  it("refuses an oversized body", async () => {
    expect((await deliver({ body: `{"pad":"${"x".repeat(70_000)}"}` })).status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// The re-check
// ---------------------------------------------------------------------------

function fakeClient(overrides: Partial<Record<keyof QditClient, unknown>> = {}): QditClient {
  const milestone = (id: string, status: QditMilestone["status"], updated = "2026-10-24T12:00:00.000Z") =>
    ({ id, project: { id: PROJECT, name: "P", slug: "p" }, status, updated_at: updated }) as QditMilestone;
  return {
    listAllProjects: vi.fn(async () => [{ id: PROJECT, chain: { network: CHAIN.network, contract_id: CHAIN.contractId } }]),
    getMilestone: vi.fn(async (id: string) => milestone(id, "approved")),
    ...overrides,
  } as unknown as QditClient;
}

describe("recheckDocStatuses (R-09)", () => {
  it("fills in a missed webhook from the chain and from qdit", async () => {
    const client = fakeClient();
    const result = await recheckDocStatuses({ store, client, docId: DOC, readChain, now: () => NOW_MS });
    expect(result.errors).toEqual([]);
    expect(result.states[MILESTONE]).toMatchObject({ qdit_status: "approved", chain_status: "Approved", chain_version: 2 });
    expect(result.states[MILESTONE_2]).toMatchObject({ chain_status: "Approved" });
    expect(client.getMilestone).toHaveBeenCalledTimes(2);
    // The project's chain was known, so it was not asked for again.
    expect(client.listAllProjects).not.toHaveBeenCalled();
  });

  it("does nothing twice: fresh reads are reused unless forced", async () => {
    const client = fakeClient();
    await recheckDocStatuses({ store, client, docId: DOC, readChain, now: () => NOW_MS });
    await recheckDocStatuses({ store, client, docId: DOC, readChain, now: () => NOW_MS + 5_000 });
    expect(readChain).toHaveBeenCalledTimes(2);
    expect(client.getMilestone).toHaveBeenCalledTimes(2);
    await recheckDocStatuses({ store, client, docId: DOC, readChain, now: () => NOW_MS + 20_000 });
    expect(readChain).toHaveBeenCalledTimes(4); // chain again after 15 s
    expect(client.getMilestone).toHaveBeenCalledTimes(2); // qdit not before 5 min
    await recheckDocStatuses({ store, client, docId: DOC, readChain, now: () => NOW_MS + 21_000, force: true });
    expect(readChain).toHaveBeenCalledTimes(6);
    expect(client.getMilestone).toHaveBeenCalledTimes(4);
    expect(client.listAllProjects).toHaveBeenCalledTimes(1);
  });

  it("puts a duplicated or out-of-order webhook right: the chain read now wins", async () => {
    // A late webhook left an old read in place...
    readChain.mockResolvedValueOnce({ ledger: 100, record: null });
    await deliver();
    expect(store.states.get(MILESTONE)?.chain_status).toBe("none");
    // ...and the panel's re-check reads the chain again.
    const result = await recheckDocStatuses({ store, client: null, docId: DOC, readChain, now: () => NOW_MS + 60_000 });
    expect(result.states[MILESTONE]).toMatchObject({ chain_status: "Approved", chain_ledger: 900 });
  });

  it("works without a qdit connection: the chain still answers", async () => {
    const client = fakeClient({
      getMilestone: vi.fn(async () => {
        throw new QditNotConnectedError("none");
      }),
    });
    const result = await recheckDocStatuses({ store, client, docId: DOC, readChain, now: () => NOW_MS });
    expect(result.errors).toEqual([]);
    expect(result.states[MILESTONE]).toMatchObject({ chain_status: "Approved", qdit_status: null });
    // Only the first batch (already in flight) asked qdit; nothing after the refusal does.
    expect(client.getMilestone).toHaveBeenCalledTimes(2);
    // A later re-check tries again (the user may have connected since).
    await recheckDocStatuses({ store, client, docId: DOC, readChain, now: () => NOW_MS + 20_000 });
    expect(client.getMilestone).toHaveBeenCalledTimes(4);
  });

  it("learns the project's chain once it is registered", async () => {
    store.chain = null;
    const result = await recheckDocStatuses({ store, client: fakeClient(), docId: DOC, readChain, now: () => NOW_MS });
    expect(store.chain).toEqual(CHAIN);
    expect(result.states[MILESTONE]?.chain_status).toBe("Approved");
  });

  it("records unregistered while the project has no chain", async () => {
    store.chain = null;
    const client = fakeClient({ listAllProjects: vi.fn(async () => [{ id: PROJECT, chain: null }]) });
    const result = await recheckDocStatuses({ store, client, docId: DOC, readChain, now: () => NOW_MS });
    expect(result.states[MILESTONE]?.chain_status).toBe("unregistered");
    expect(readChain).not.toHaveBeenCalled();
  });

  it("reports failures briefly and keeps what it had", async () => {
    readChain.mockRejectedValue(new QditChainError("unreachable", "down"));
    const client = fakeClient({
      getMilestone: vi.fn(async () => {
        throw new QditError("rate_limited", "busy");
      }),
    });
    const result = await recheckDocStatuses({ store, client, docId: DOC, readChain, now: () => NOW_MS });
    expect(result.errors).toEqual([
      "qdit is busy; showing what Stellar says.",
      "Stellar couldn't be reached; the statuses shown may be out of date.",
    ]);
  });

  it("returns nothing for a note with no project", async () => {
    store.loadDoc = async () => ({ project: null, links: [], states: {} });
    expect(await recheckDocStatuses({ store, client: fakeClient(), docId: DOC, readChain })).toEqual({ states: {}, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// The Supabase store: what it hands the database
// ---------------------------------------------------------------------------

describe("supabaseStatusStore", () => {
  it("passes every field to record_qdit_milestone_state by name", async () => {
    const { supabaseStatusStore } = await import("@/lib/integrations/qdit-status-sync");
    const rpc = vi.fn(async () => ({ data: "recorded", error: null }));
    const s = supabaseStatusStore({ rpc } as never);
    expect(
      await s.record({
        projectId: PROJECT,
        milestoneId: MILESTONE,
        qditStatus: { status: "approved", at: "2026-10-24T12:00:00.000Z" },
        chain: { status: "Approved", network: "testnet", contractId: CHAIN.contractId, version: 2, ledger: 900 },
        eventId: "7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10",
      }),
    ).toBe("recorded");
    expect(rpc).toHaveBeenCalledWith("record_qdit_milestone_state", {
      p_project_id: PROJECT,
      p_milestone_id: MILESTONE,
      p_qdit_status: "approved",
      p_qdit_status_at: "2026-10-24T12:00:00.000Z",
      p_chain_status: "Approved",
      p_chain_network: "testnet",
      p_chain_contract_id: CHAIN.contractId,
      p_chain_version: 2,
      p_chain_ledger: 900,
      p_qdit_checked: false,
      p_event_id: "7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10",
    });
    await s.record({ projectId: PROJECT, milestoneId: MILESTONE, chain: { status: "unregistered" } });
    expect(rpc).toHaveBeenLastCalledWith(
      "record_qdit_milestone_state",
      expect.objectContaining({ p_chain_status: "unregistered", p_chain_network: null, p_chain_ledger: null, p_event_id: null }),
    );
  });

  it("claims an event and refuses an answer it does not know", async () => {
    const { supabaseStatusStore } = await import("@/lib/integrations/qdit-status-sync");
    const event = (parseWebhookEvent(bytes(BODY)) as { event: WebhookEvent }).event;
    const rpc = vi.fn(async () => ({ data: "done", error: null }));
    expect(await supabaseStatusStore({ rpc } as never).claimEvent(event)).toBe("done");
    expect(rpc).toHaveBeenCalledWith("claim_qdit_webhook_event", {
      p_id: event.id,
      p_event: "milestone.status_changed",
      p_project_id: PROJECT,
      p_milestone_id: MILESTONE,
      p_status: "approved",
      p_occurred_at: "2026-10-24T11:59:58.412Z",
    });
    const odd = vi.fn(async () => ({ data: "maybe", error: null }));
    await expect(supabaseStatusStore({ rpc: odd } as never).claimEvent(event)).rejects.toThrow();
    const failing = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    await expect(supabaseStatusStore({ rpc: failing } as never).claimEvent(event)).rejects.toThrow("boom");
  });
});
