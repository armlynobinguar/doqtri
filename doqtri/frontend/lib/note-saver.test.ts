import { describe, expect, it, vi } from "vitest";
import { createNoteSaver } from "@/lib/note-saver";
import type { DocLockState } from "@/lib/doc-lock-client";

const DOC = "30000000-0000-4000-8000-000000000010";
const TAB = "a0000000-0000-4000-8000-000000000003";

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeLock(held = true, holderName: string | null = null) {
  const state: DocLockState = {
    phase: held ? "mine" : "other",
    holderName,
    canEdit: true,
    canTakeOver: false,
    version: 1,
    error: null,
  };
  return {
    session: TAB,
    ensure: vi.fn(async () => held),
    refresh: vi.fn(async () => {}),
    getState: () => state,
  };
}

describe("createNoteSaver", () => {
  it("saves with the base version and adopts the new one", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { id: DOC, version: 4 }));
    const saver = createNoteSaver({
      docId: DOC,
      markdown: "# a",
      version: 3,
      lock: fakeLock(),
      onConflict: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await saver.queue.save("# b");
    expect(saver.version).toBe(4);
    expect(saver.queue.saved).toBe("# b");

    const [url, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe(`/api/notes/${DOC}`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ markdown: "# b", version: 3, session: TAB });

    await saver.queue.save("# c");
    const second = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[1];
    expect(JSON.parse(String(second[1].body)).version).toBe(4);
  });

  it("sends nothing without the lock, naming who has it", async () => {
    const fetchImpl = vi.fn();
    const saver = createNoteSaver({
      docId: DOC,
      markdown: "# a",
      version: 1,
      lock: fakeLock(false, "ana"),
      onConflict: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(saver.queue.save("# b")).rejects.toThrow("ana is editing this note");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saver.queue.saved).toBe("# a");
  });

  it("reports a stale version as a conflict and keeps the old version", async () => {
    const onConflict = vi.fn();
    const fetchImpl = vi.fn(async () =>
      respond(409, { error: "This note was changed elsewhere", code: "STALE_VERSION", version: 5 }),
    );
    const saver = createNoteSaver({
      docId: DOC,
      markdown: "# a",
      version: 3,
      lock: fakeLock(),
      onConflict,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(saver.queue.save("# b")).rejects.toThrow("This note was changed elsewhere");
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(saver.version).toBe(3);
    expect(saver.queue.saved).toBe("# a");
  });

  it("re-reads the lock when the server says it was lost", async () => {
    const lock = fakeLock();
    const fetchImpl = vi.fn(async () => respond(423, { error: "admin is editing this note" }));
    const saver = createNoteSaver({
      docId: DOC,
      markdown: "# a",
      version: 1,
      lock,
      onConflict: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(saver.queue.save("# b")).rejects.toThrow("admin is editing this note");
    expect(lock.refresh).toHaveBeenCalledTimes(1);
  });

  it("takes a version set from outside, after a reload", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { id: DOC, version: 8 }));
    const saver = createNoteSaver({
      docId: DOC,
      markdown: "# a",
      version: 1,
      lock: fakeLock(),
      onConflict: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    saver.setVersion(7);
    await saver.queue.save("# b");
    const [, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0];
    expect(JSON.parse(String(init.body)).version).toBe(7);
  });

  it("sends the last save as it leaves with the lock's release, as a keepalive request (DOQ-43)", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { id: DOC, version: 4 }));
    const saver = createNoteSaver({
      docId: DOC,
      markdown: "# a",
      version: 3,
      lock: fakeLock(),
      onConflict: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const earlier = saver.queue.save("# b");
    const leaving = saver.leave("# c");
    expect(leaving.outlivesPage()).toBe(false);
    await Promise.all([earlier, leaving.done]);
    expect(leaving.outlivesPage()).toBe(true);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    // Only the last write asks for the release: an earlier one queued
    // before it must not free the lock under it.
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ markdown: "# b", version: 3, session: TAB });
    expect(calls[0][1].keepalive).toBeUndefined();
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ markdown: "# c", version: 4, session: TAB, release: true });
    expect(calls[1][1].keepalive).toBe(true);
    expect(saver.queue.saved).toBe("# c");
  });

  it("sends a last save too large for keepalive as a plain request", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { id: DOC, version: 2 }));
    const saver = createNoteSaver({
      docId: DOC,
      markdown: "# a",
      version: 1,
      lock: fakeLock(),
      onConflict: vi.fn(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const leaving = saver.leave("x".repeat(70_000));
    await leaving.done;
    const [, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0];
    expect(JSON.parse(String(init.body)).release).toBe(true);
    expect(init.keepalive).toBeUndefined();
    expect(leaving.outlivesPage()).toBe(false);
  });

  it("gives up on a last save that does not answer in time, aborting its request", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) => {
            signal = init.signal ?? undefined;
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      const saver = createNoteSaver({
        docId: DOC,
        markdown: "# a",
        version: 1,
        lock: fakeLock(),
        onConflict: vi.fn(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        leaveTimeoutMs: 10_000,
      });
      const leaving = saver.leave("# b");
      const failed = expect(leaving.done).rejects.toThrow("did not finish in time");
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;
      expect(signal?.aborted).toBe(true);
      // Not stored: the editor keeps the text as unsaved.
      expect(saver.queue.saved).toBe("# a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up too when the last save waits behind a write that never answers", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
      const saver = createNoteSaver({
        docId: DOC,
        markdown: "# a",
        version: 1,
        lock: fakeLock(),
        onConflict: vi.fn(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        leaveTimeoutMs: 10_000,
      });
      void saver.queue.save("# b").catch(() => {});
      const leaving = saver.leave("# c");
      const failed = expect(leaving.done).rejects.toThrow("did not finish in time");
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;
      // Its request never went out, so nothing would outlive a closing page.
      expect(leaving.outlivesPage()).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
