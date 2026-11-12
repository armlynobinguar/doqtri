import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseHackathonReleased,
  supabaseHackathonReleaseStore,
  type HackathonReleasedEvent,
  type HackathonReleaseStore,
} from "@/lib/integrations/qdit-hackathon-release";
import { handleQditWebhook, parseWebhookEvent, type StatusStore } from "@/lib/integrations/qdit-status-sync";

/*
 * qdit's `hackathon.released` webhook event (WP-4.7, DOQ-54; contract
 * v1.5.0 section 9): signed and checked like `milestone.status_changed`,
 * recorded by id in the same idempotency store, and the hackathon's links
 * given released_at + 24 h, never later. The store here is in memory with the
 * same rules as record_qdit_hackathon_release() (tested in SQL in
 * backend/tests/mindmap_share_expiry.test.sql).
 */

const SECRET = "whsec_example_do_not_use";
const TIMESTAMP = "1794480000";
const NOW_MS = Number(TIMESTAMP) * 1000 + 1_000;
const EVENT_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const RELEASE = {
  id: EVENT_ID,
  event: "hackathon.released",
  hackathon_slug: "stellar-build-2026",
  released_at: "2026-11-20T12:00:00.000Z",
  occurred_at: "2026-11-20T12:00:00.250Z",
};

const bytes = (text: string) => new TextEncoder().encode(text);
const sign = (body: string, timestamp = TIMESTAMP, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
const body = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...RELEASE, ...overrides });

/** The milestone half is never reached by a release event. */
const milestoneStore = new Proxy({} as StatusStore, {
  get: (_t, name) => () => {
    throw new Error(`a release event must not touch the milestone store (${String(name)})`);
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Links per hackathon and their expiries, and the release rules of the SQL. */
function memoryReleases(links: Record<string, { hackathon: string; expiresAt: number | null }>) {
  const seen = new Set<string>();
  const releases = new Map<string, { expiresAt: number; occurredAt: number }>();
  const store: HackathonReleaseStore & { links: typeof links; recorded: HackathonReleasedEvent[] } = {
    links,
    recorded: [],
    async record(event) {
      store.recorded.push(event);
      if (seen.has(event.id)) {
        const kept = releases.get(event.hackathonSlug);
        return { outcome: "duplicate", expiresAt: kept ? new Date(kept.expiresAt).toISOString() : null, linksUpdated: 0 };
      }
      seen.add(event.id);
      const expiresAt = Date.parse(event.releasedAt) + DAY_MS;
      const occurredAt = Date.parse(event.occurredAt);
      const kept = releases.get(event.hackathonSlug);
      if (!kept) releases.set(event.hackathonSlug, { expiresAt, occurredAt });
      else if (occurredAt > kept.occurredAt) releases.set(event.hackathonSlug, { expiresAt: Math.min(kept.expiresAt, expiresAt), occurredAt });
      const expiry = releases.get(event.hackathonSlug)!.expiresAt;
      let n = 0;
      for (const link of Object.values(links)) {
        if (link.hackathon === event.hackathonSlug && (link.expiresAt === null || link.expiresAt > expiry)) {
          link.expiresAt = expiry;
          n++;
        }
      }
      return { outcome: "applied", expiresAt: new Date(expiry).toISOString(), linksUpdated: n };
    },
  };
  return store;
}

const deliver = (raw: string, releases?: HackathonReleaseStore, signature = sign(raw)) =>
  handleQditWebhook({
    rawBody: bytes(raw),
    timestamp: TIMESTAMP,
    signature,
    secret: SECRET,
    nowMs: NOW_MS,
    store: milestoneStore,
    readChain: async () => {
      throw new Error("no chain read for a release");
    },
    releases,
  });

describe("parseHackathonReleased", () => {
  it("reads the contract's body", () => {
    expect(parseWebhookEvent(bytes(body()))).toEqual({
      kind: "released",
      event: {
        id: EVENT_ID,
        event: "hackathon.released",
        hackathonSlug: "stellar-build-2026",
        releasedAt: "2026-11-20T12:00:00.000Z",
        occurredAt: "2026-11-20T12:00:00.250Z",
      },
    });
  });

  it("lowercases the id and writes timestamps as UTC ISO 8601", () => {
    expect(parseHackathonReleased({ ...RELEASE, id: EVENT_ID.toUpperCase(), released_at: "2026-11-20T20:00:00+08:00" })).toMatchObject({
      id: EVENT_ID,
      releasedAt: "2026-11-20T12:00:00.000Z",
    });
  });

  it.each([
    ["no id", { id: undefined }],
    ["an id that is not a UUID", { id: "release-1" }],
    ["a slug outside ^[a-z0-9-]{1,64}$", { hackathon_slug: "Stellar Build" }],
    ["no slug", { hackathon_slug: undefined }],
    ["released_at that is not a time", { released_at: "after judging" }],
    ["no occurred_at", { occurred_at: undefined }],
  ])("is invalid with %s", (_name, overrides) => {
    expect(parseWebhookEvent(bytes(body(overrides)))).toMatchObject({ kind: "invalid" });
  });
});

describe("handleQditWebhook: hackathon.released", () => {
  const links = () => ({
    a: { hackathon: "stellar-build-2026", expiresAt: null },
    b: { hackathon: "stellar-build-2026", expiresAt: Date.parse("2026-11-20T18:00:00Z") },
    other: { hackathon: "another-one", expiresAt: null },
  });

  it("gives the hackathon's links released_at + 24 h, keeps an earlier expiry, and leaves other hackathons alone", async () => {
    const releases = memoryReleases(links());
    expect(await deliver(body(), releases)).toEqual({ status: 200, body: { ok: true } });
    expect(releases.links.a.expiresAt).toBe(Date.parse("2026-11-21T12:00:00.000Z"));
    expect(releases.links.b.expiresAt).toBe(Date.parse("2026-11-20T18:00:00Z"));
    expect(releases.links.other.expiresAt).toBeNull();
  });

  it("answers a replay as a duplicate and changes nothing", async () => {
    const releases = memoryReleases(links());
    await deliver(body(), releases);
    const before = JSON.stringify(releases.links);
    expect(await deliver(body({ released_at: "2026-12-30T00:00:00.000Z" }), releases)).toEqual({
      status: 200,
      body: { ok: true, duplicate: true },
    });
    expect(JSON.stringify(releases.links)).toBe(before);
  });

  it("never extends an expiry: an older or a later-released event changes nothing", async () => {
    const releases = memoryReleases(links());
    await deliver(body(), releases);
    const before = JSON.stringify(releases.links);
    await deliver(body({ id: "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5e", occurred_at: "2026-11-19T00:00:00.000Z", released_at: "2026-11-01T00:00:00.000Z" }), releases);
    await deliver(body({ id: "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5f", occurred_at: "2026-11-25T00:00:00.000Z", released_at: "2026-11-24T00:00:00.000Z" }), releases);
    expect(JSON.stringify(releases.links)).toBe(before);
  });

  it("checks the signature first, like any event", async () => {
    const releases = memoryReleases(links());
    const res = await deliver(body(), releases, sign(body(), TIMESTAMP, "wrong-secret"));
    expect(res.status).toBe(401);
    expect(releases.recorded).toEqual([]);
  });

  it("refuses a malformed release with 400 and records nothing", async () => {
    const releases = memoryReleases(links());
    expect((await deliver(body({ hackathon_slug: "Not A Slug" }), releases)).status).toBe(400);
    expect(releases.recorded).toEqual([]);
  });

  it("asks qdit to retry (503) when the release cannot be recorded", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: HackathonReleaseStore = { record: async () => Promise.reject(new Error("db down")) };
    expect(await deliver(body(), failing)).toEqual({ status: 503, body: { error: "Could not process the event. Retry later." } });
    log.mockRestore();
  });

  it("is dropped like an unknown event where no release store is given", async () => {
    expect(await deliver(body())).toEqual({ status: 200, body: { ok: true, ignored: "unknown_event" } });
  });

  it("still acknowledges and drops event types it does not know", async () => {
    const releases = memoryReleases(links());
    expect(await deliver(body({ event: "hackathon.archived" }), releases)).toEqual({
      status: 200,
      body: { ok: true, ignored: "unknown_event" },
    });
    expect(releases.recorded).toEqual([]);
  });
});

describe("supabaseHackathonReleaseStore", () => {
  const event = parseHackathonReleased(RELEASE)!;

  it("calls record_qdit_hackathon_release with the event", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ outcome: "applied", link_expires_at: "2026-11-21T12:00:00+00:00", links_updated: 3 }],
      error: null,
    }));
    expect(await supabaseHackathonReleaseStore({ rpc } as never).record(event)).toEqual({
      outcome: "applied",
      expiresAt: "2026-11-21T12:00:00+00:00",
      linksUpdated: 3,
    });
    expect(rpc).toHaveBeenCalledWith("record_qdit_hackathon_release", {
      p_id: EVENT_ID,
      p_hackathon_slug: "stellar-build-2026",
      p_released_at: "2026-11-20T12:00:00.000Z",
      p_occurred_at: "2026-11-20T12:00:00.250Z",
    });
  });

  it("throws on a database error or an answer it does not know", async () => {
    const failing = vi.fn(async () => ({ data: null, error: { message: "boom" } }));
    await expect(supabaseHackathonReleaseStore({ rpc: failing } as never).record(event)).rejects.toThrow("boom");
    const odd = vi.fn(async () => ({ data: [{ outcome: "maybe" }], error: null }));
    await expect(supabaseHackathonReleaseStore({ rpc: odd } as never).record(event)).rejects.toThrow();
  });
});
