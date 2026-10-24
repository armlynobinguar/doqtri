import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocLockStatus } from "@/lib/doc-lock";
import {
  createDocLockApi,
  createDocLockController,
  type DocLockApi,
} from "@/lib/doc-lock-client";

const DOC = "30000000-0000-4000-8000-000000000010";
const ME = "00000000-0000-4000-8000-000000000003";
const ANA = "00000000-0000-4000-8000-000000000006";

const HEARTBEAT = 60_000;
const IDLE = 10 * 60_000;
const POLL = 15_000;

function status(over: Partial<DocLockStatus> = {}): DocLockStatus {
  return {
    documentId: DOC,
    holder: null,
    holderName: null,
    acquiredAt: null,
    heartbeatAt: null,
    expiresAt: null,
    mine: false,
    canEdit: true,
    canTakeOver: false,
    version: 1,
    ...over,
  };
}

const mine = (over: Partial<DocLockStatus> = {}) =>
  status({ holder: ME, holderName: "me", mine: true, ...over });
const ana = (over: Partial<DocLockStatus> = {}) =>
  status({ holder: ANA, holderName: "ana", ...over });

/** An API whose answers the test sets, recording each call. */
function fakeApi(initial: DocLockStatus = status()) {
  const calls: string[] = [];
  const server = { current: initial, takeResult: null as DocLockStatus | null };
  const api: DocLockApi = {
    status: vi.fn(async () => {
      calls.push("status");
      return server.current;
    }),
    take: vi.fn(async (takeover: boolean) => {
      calls.push(takeover ? "takeover" : "take");
      if (server.takeResult) return server.takeResult;
      if (!server.current.holder || server.current.mine || takeover) {
        server.current = mine({ version: server.current.version, canTakeOver: server.current.canTakeOver });
      }
      return server.current;
    }),
    release: vi.fn(async (options?: { keepalive?: boolean }) => {
      calls.push(options?.keepalive ? "release:keepalive" : "release");
      if (server.current.mine) server.current = status({ version: server.current.version });
    }),
  };
  return { api, calls, server };
}

function controllerFor(api: DocLockApi, handlers: Parameters<typeof createDocLockController>[0] = { api }) {
  return createDocLockController({
    heartbeatMs: HEARTBEAT,
    idleMs: IDLE,
    pollMs: POLL,
    ...handlers,
    api,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("opening a note", () => {
  it("reads the status but takes nothing", async () => {
    const { api, calls } = fakeApi();
    const c = controllerFor(api);
    expect(c.getState().phase).toBe("loading");
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState()).toMatchObject({ phase: "free", canEdit: true });
    expect(calls).toEqual(["status"]);
    c.stop();
  });

  it("goes read-only with the holder's name when someone else is editing", async () => {
    const { api } = fakeApi(ana({ canTakeOver: true }));
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState()).toMatchObject({ phase: "other", holderName: "ana", canTakeOver: true });
    expect(await c.noteEdit()).toBe(false);
    expect(api.take).not.toHaveBeenCalled();
    c.stop();
  });

  it("never takes the lock for a viewer", async () => {
    const { api } = fakeApi(status({ canEdit: false }));
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await c.noteEdit()).toBe(false);
    expect(await c.ensure()).toBe(false);
    expect(api.take).not.toHaveBeenCalled();
    c.stop();
  });
});

describe("editing", () => {
  it("takes the lock on the first edit, once, however many edits race it", async () => {
    const { api } = fakeApi();
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    const results = await Promise.all([c.noteEdit(), c.noteEdit(), c.noteEdit()]);
    expect(results).toEqual([true, true, true]);
    expect(api.take).toHaveBeenCalledTimes(1);
    expect(c.getState().phase).toBe("mine");
    c.stop();
  });

  it("heartbeats every minute that saw an edit, and not otherwise", async () => {
    const { api, calls } = fakeApi();
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.noteEdit();
    calls.length = 0;

    await c.noteEdit();
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(calls).toEqual(["take"]);

    // A quiet minute: no heartbeat.
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(calls).toEqual(["take"]);

    await c.noteEdit();
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(calls).toEqual(["take", "take"]);
    c.stop();
  });

  it("releases after ten idle minutes and takes it again on the next edit", async () => {
    const { api, calls } = fakeApi();
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.noteEdit();
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(IDLE - HEARTBEAT);
    expect(calls).not.toContain("release");
    expect(c.getState().phase).toBe("mine");

    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(calls).toContain("release");
    expect(c.getState().phase).toBe("free");

    expect(await c.noteEdit()).toBe(true);
    expect(c.getState().phase).toBe("mine");
    c.stop();
  });

  it("goes read-only and reports it when a heartbeat finds the lock taken over", async () => {
    const onLost = vi.fn();
    const { api, server } = fakeApi();
    const c = controllerFor(api, { api, onLost });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.noteEdit();

    server.current = status({ holder: "admin", holderName: "admin", version: 1 });
    server.takeResult = server.current;
    await c.noteEdit();
    await vi.advanceTimersByTimeAsync(HEARTBEAT);

    expect(c.getState()).toMatchObject({ phase: "other", holderName: "admin" });
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0][0]).toMatchObject({ holderName: "admin" });
    c.stop();
  });

  it("loses a race for a free lock gracefully", async () => {
    const { api, server } = fakeApi();
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    server.takeResult = ana();
    expect(await c.noteEdit()).toBe(false);
    expect(c.getState()).toMatchObject({ phase: "other", holderName: "ana" });
    c.stop();
  });

  it("keeps the editor usable when a take fails on the network", async () => {
    const { api } = fakeApi();
    (api.take as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await c.noteEdit()).toBe(false);
    expect(c.getState()).toMatchObject({ phase: "free", error: "offline" });
    expect(await c.noteEdit()).toBe(true);
    expect(c.getState().error).toBeNull();
    c.stop();
  });
});

describe("while someone else edits", () => {
  it("polls, reports their saves and becomes editable when they finish", async () => {
    const onStatus = vi.fn();
    const { api, server } = fakeApi(ana({ version: 3 }));
    const c = controllerFor(api, { api, onStatus });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ version: 3 }));

    server.current = ana({ version: 4 });
    await vi.advanceTimersByTimeAsync(POLL);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ version: 4 }));
    expect(c.getState()).toMatchObject({ phase: "other", version: 4 });

    server.current = status({ version: 5 });
    await vi.advanceTimersByTimeAsync(POLL);
    expect(c.getState()).toMatchObject({ phase: "free", version: 5, holderName: null });
    c.stop();
  });

  it("lets an admin take over", async () => {
    const { api, calls } = fakeApi(ana({ canTakeOver: true }));
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await c.takeOver()).toBe(true);
    expect(calls).toContain("takeover");
    expect(c.getState().phase).toBe("mine");
    c.stop();
  });

  it("does not even ask for a takeover without the right", async () => {
    const { api } = fakeApi(ana({ canTakeOver: false }));
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await c.takeOver()).toBe(false);
    expect(api.take).not.toHaveBeenCalled();
    c.stop();
  });
});

describe("leaving", () => {
  it("releases a held lock with keepalive and stops the schedule", async () => {
    const { api, calls } = fakeApi();
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.noteEdit();
    c.stop({ keepalive: true });
    c.stop({ keepalive: true });
    expect(calls.filter((x) => x.startsWith("release"))).toEqual(["release:keepalive"]);

    calls.length = 0;
    await vi.advanceTimersByTimeAsync(IDLE * 2);
    expect(calls).toEqual([]);
  });

  it("releases nothing it does not hold", async () => {
    const { api } = fakeApi(ana());
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    c.stop({ keepalive: true });
    expect(api.release).not.toHaveBeenCalled();
  });

  it("starts over when the page comes back", async () => {
    const { api } = fakeApi();
    const c = controllerFor(api);
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.noteEdit();
    c.stop({ keepalive: true });
    c.start();
    expect(c.getState().phase).toBe("loading");
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().phase).toBe("free");
    c.stop();
  });
});

describe("createDocLockApi", () => {
  function respond(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }
  const row = {
    document_id: DOC,
    holder: ANA,
    holder_name: "ana",
    acquired_at: null,
    heartbeat_at: null,
    expires_at: null,
    mine: false,
    can_edit: true,
    can_take_over: true,
    version: 2,
  };

  it("calls the lock route with the right methods", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { lock: { ...row, mine: true } }));
    const api = createDocLockApi(DOC, fetchImpl as unknown as typeof fetch);
    await api.status();
    await api.take(false);
    await api.take(true);
    await api.release({ keepalive: true });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `GET /api/notes/${DOC}/lock`,
      `POST /api/notes/${DOC}/lock`,
      `POST /api/notes/${DOC}/lock?takeover=1`,
      `DELETE /api/notes/${DOC}/lock`,
    ]);
    expect(calls[3][1].keepalive).toBe(true);
  });

  it("reads the status out of a 423", async () => {
    const fetchImpl = vi.fn(async () => respond(423, { error: "ana is editing this note", lock: row }));
    const api = createDocLockApi(DOC, fetchImpl as unknown as typeof fetch);
    await expect(api.take(false)).resolves.toMatchObject({ mine: false, holderName: "ana" });
  });

  it("throws the route's message for anything else", async () => {
    const fetchImpl = vi.fn(async () => respond(403, { error: "You can read this note but not change it." }));
    const api = createDocLockApi(DOC, fetchImpl as unknown as typeof fetch);
    await expect(api.take(false)).rejects.toThrow("You can read this note but not change it.");
  });
});
