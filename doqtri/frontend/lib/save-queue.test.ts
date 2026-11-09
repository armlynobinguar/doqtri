import { describe, expect, it } from "vitest";
import { createSaveQueue } from "@/lib/save-queue";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSaveQueue", () => {
  it("skips text that is already saved", async () => {
    const writes: string[] = [];
    const queue = createSaveQueue("a", async (text) => {
      writes.push(text);
    });

    await queue.save("a");

    expect(writes).toEqual([]);
  });

  it("records the text once it is written", async () => {
    const queue = createSaveQueue("a", async () => {});

    await queue.save("b");

    expect(queue.saved).toBe("b");
  });

  it("starts a write only after the one in flight finishes", async () => {
    const first = deferred();
    const started: string[] = [];
    const queue = createSaveQueue("a", (text) => {
      started.push(text);
      return text === "b" ? first.promise : Promise.resolve();
    });

    const b = queue.save("b");
    const c = queue.save("c");
    await Promise.resolve();
    expect(started).toEqual(["b"]);

    first.resolve();
    await Promise.all([b, c]);

    expect(started).toEqual(["b", "c"]);
    expect(queue.saved).toBe("c");
  });

  it("keeps the old baseline when a write fails", async () => {
    const queue = createSaveQueue("a", async () => {
      throw new Error("offline");
    });

    await expect(queue.save("b")).rejects.toThrow("offline");

    expect(queue.saved).toBe("a");
  });

  it("still runs writes queued behind a failed one", async () => {
    const first = deferred();
    const queue = createSaveQueue("a", (text) =>
      text === "b" ? first.promise : Promise.resolve(),
    );

    const b = queue.save("b");
    const c = queue.save("c");
    first.reject(new Error("offline"));

    await expect(b).rejects.toThrow("offline");
    await c;
    expect(queue.saved).toBe("c");
  });

  it("skips a queued write made redundant by markSaved", async () => {
    const writes: string[] = [];
    const queue = createSaveQueue("a", async (text) => {
      writes.push(text);
    });

    queue.markSaved("b");
    await queue.save("b");

    expect(writes).toEqual([]);
  });

  it("runs a task after the write in flight and holds later writes until it settles", async () => {
    const first = deferred();
    const task = deferred();
    const events: string[] = [];
    const queue = createSaveQueue("a", async (text) => {
      events.push(`write ${text}`);
      if (text === "b") await first.promise;
    });

    const b = queue.save("b");
    const ran = queue.run(async () => {
      events.push("task");
      await task.promise;
      // What the task wrote itself becomes the baseline.
      queue.markSaved("renamed");
      return 7;
    });
    const c = queue.save("renamed");
    await Promise.resolve();
    expect(events).toEqual(["write b"]);

    first.resolve();
    await b;
    await Promise.resolve();
    expect(events).toEqual(["write b", "task"]);

    task.resolve();
    expect(await ran).toBe(7);
    await c;
    // The save queued during the task found its text already stored.
    expect(events).toEqual(["write b", "task"]);
  });

  it("keeps writing after a task that failed", async () => {
    const writes: string[] = [];
    const queue = createSaveQueue("a", async (text) => {
      writes.push(text);
    });

    await expect(queue.run(async () => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
    await queue.save("b");
    expect(writes).toEqual(["b"]);
  });
});
