import { describe, expect, it, vi } from "vitest";
import { QditError, type QditClient } from "@/lib/integrations/qdit-client";
import type { ConnectionStore, StoredConnection } from "@/lib/integrations/connection-store";
import { createPreviewCache, loadMilestonePreview } from "@/lib/integrations/qdit-milestone-preview";

/*
 * The milestone card's server side (WP-2.6): the user's own connection, the
 * no-access mapping, and the short cache.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000004";
const MILESTONE_ID = "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61";

const milestone = (title = "Escrow contract") => ({
  id: MILESTONE_ID,
  project: { id: "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34", name: "Soroban payroll", slug: "soroban-payroll" },
  title,
  status: "approved",
  due_date: null,
  url: "https://qdit.test/m",
  link: null,
  anchor: null,
  updated_at: "2026-10-22T08:11:40.000Z",
});

function conn(over: Partial<StoredConnection> = {}): StoredConnection {
  return {
    userId: ME,
    subject: "qdit-user-1",
    accountLabel: null,
    scopes: [],
    status: "connected",
    generation: 1,
    expiresAt: null,
    accessToken: "at",
    refreshToken: "rt",
    ...over,
  };
}

function setup(connections: Record<string, StoredConnection | null> = { [ME]: conn() }) {
  const getMilestone = vi.fn(async () => milestone() as never);
  const store = { load: vi.fn(async (userId: string) => connections[userId] ?? null) } as unknown as ConnectionStore;
  const client = vi.fn(() => ({ getMilestone }) as unknown as QditClient);
  let now = 1_000_000;
  const cache = createPreviewCache({ ttlMs: 30_000, now: () => now });
  const load = (userId = ME, milestoneId = MILESTONE_ID) =>
    loadMilestonePreview({ userId, milestoneId, store, client, cache });
  return { getMilestone, store, client, cache, load, tick: (ms: number) => (now += ms), connections };
}

describe("loadMilestonePreview", () => {
  it("reads the milestone with the user's own client and keeps only the card's fields", async () => {
    const t = setup();
    const outcome = await t.load();
    expect(outcome.kind).toBe("loaded");
    expect(t.getMilestone).toHaveBeenCalledWith(MILESTONE_ID);
    if (outcome.kind === "loaded") expect(outcome.milestone.status).toBe("approved");
  });

  it("asks qdit nothing without a usable connection", async () => {
    const none = setup({});
    await expect(none.load()).rejects.toMatchObject({ kind: "not_connected", connection: "none" });
    const lapsed = setup({ [ME]: conn({ status: "needs_reconnect", accessToken: null }) });
    await expect(lapsed.load()).rejects.toMatchObject({ kind: "not_connected", connection: "needs_reconnect" });
    const revoked = setup({ [ME]: conn({ status: "revoked", accessToken: null }) });
    await expect(revoked.load()).rejects.toMatchObject({ connection: "revoked" });
    const undecryptable = setup({ [ME]: conn({ accessToken: null }) });
    await expect(undecryptable.load()).rejects.toMatchObject({ connection: "needs_reconnect" });
    for (const t of [none, lapsed, revoked, undecryptable]) expect(t.getMilestone).not.toHaveBeenCalled();
  });

  it("qdit's 404 and 403 are both no access", async () => {
    for (const kind of ["not_found", "forbidden"] as const) {
      const t = setup();
      t.getMilestone.mockRejectedValueOnce(new QditError(kind, "x", { status: kind === "forbidden" ? 403 : 404 }));
      expect(await t.load()).toEqual({ kind: "no_access" });
    }
  });

  it("other failures are thrown as they are, and a milestone it can't read is bad_response", async () => {
    const t = setup();
    t.getMilestone.mockRejectedValueOnce(new QditError("unavailable", "down"));
    await expect(t.load()).rejects.toMatchObject({ kind: "unavailable" });
    t.getMilestone.mockResolvedValueOnce({ id: MILESTONE_ID } as never);
    await expect(t.load()).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("the short cache", () => {
  it("keeps an answer for the TTL, then asks again", async () => {
    const t = setup();
    await t.load();
    await t.load();
    expect(t.getMilestone).toHaveBeenCalledTimes(1);
    t.tick(29_999);
    await t.load();
    expect(t.getMilestone).toHaveBeenCalledTimes(1);
    t.tick(1);
    t.getMilestone.mockResolvedValueOnce(milestone("Renamed") as never);
    const outcome = await t.load();
    expect(t.getMilestone).toHaveBeenCalledTimes(2);
    expect(outcome.kind === "loaded" && outcome.milestone.title).toBe("Renamed");
  });

  it("still checks the connection on a hit: a disconnect shows at once", async () => {
    const t = setup();
    await t.load();
    t.connections[ME] = conn({ status: "revoked", accessToken: null });
    await expect(t.load()).rejects.toMatchObject({ kind: "not_connected" });
  });

  it("is per doqtri user and per qdit account, never shared", async () => {
    const t = setup({ [ME]: conn(), [OTHER]: conn({ userId: OTHER, subject: "qdit-user-2" }) });
    await t.load(ME);
    await t.load(OTHER);
    expect(t.getMilestone).toHaveBeenCalledTimes(2);
    expect(t.client).toHaveBeenCalledTimes(2);
    // Reconnected as another qdit account: not the old account's answer.
    t.connections[ME] = conn({ subject: "qdit-user-9" });
    await t.load(ME);
    expect(t.getMilestone).toHaveBeenCalledTimes(3);
  });

  it("shares one request between concurrent cards", async () => {
    const t = setup();
    await Promise.all([t.load(), t.load(), t.load()]);
    expect(t.getMilestone).toHaveBeenCalledTimes(1);
  });

  it("keeps no access, but not a failure", async () => {
    const t = setup();
    t.getMilestone.mockRejectedValueOnce(new QditError("not_found", "x"));
    await t.load();
    await t.load();
    expect(t.getMilestone).toHaveBeenCalledTimes(1);

    const u = setup();
    u.getMilestone.mockRejectedValueOnce(new QditError("rate_limited", "x", { retryAfterSeconds: 5 }));
    await expect(u.load()).rejects.toMatchObject({ kind: "rate_limited" });
    expect((await u.load()).kind).toBe("loaded");
    expect(u.getMilestone).toHaveBeenCalledTimes(2);
  });

  it("drops the oldest entries past its size", async () => {
    const cache = createPreviewCache({ maxEntries: 2, now: () => 0 });
    const loader = vi.fn(async () => ({ kind: "no_access" }) as const);
    await cache.get("a", loader);
    await cache.get("b", loader);
    await cache.get("c", loader);
    await cache.get("b", loader);
    expect(loader).toHaveBeenCalledTimes(3);
    await cache.get("a", loader);
    expect(loader).toHaveBeenCalledTimes(4);
  });
});
