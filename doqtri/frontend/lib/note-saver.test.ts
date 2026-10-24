import { describe, expect, it, vi } from "vitest";
import { createNoteSaver } from "@/lib/note-saver";
import type { DocLockState } from "@/lib/doc-lock-client";

const DOC = "30000000-0000-4000-8000-000000000010";

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
    expect(JSON.parse(String(init.body))).toEqual({ markdown: "# b", version: 3 });

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
});
