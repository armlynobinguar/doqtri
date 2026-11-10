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
    const ran = queue.run(
      async () => {
        events.push("task");
        await task.promise;
        // What the task wrote itself becomes the baseline.
        queue.markSaved("renamed");
        return 7;
      },
      () => "renamed",
    );
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

    await expect(queue.run(async () => Promise.reject(new Error("refused")), () => "a")).rejects.toThrow(
      "refused",
    );
    await queue.save("b");
    expect(writes).toEqual(["b"]);
  });

  it("writes the current text, not its own, for a save queued while a task ran (DOQ-35)", async () => {
    const task = deferred();
    const writes: string[] = [];
    let editor = "# Old\nBody typed";
    const queue = createSaveQueue("# Old\nBody", async (text) => {
      writes.push(text);
    });

    const ran = queue.run(async () => {
      await task.promise;
      // The task wrote the renamed heading; the editor adopts it and keeps
      // what was typed meanwhile.
      queue.markSaved("# New\nBody");
      editor = "# New\nBody typed";
    }, () => editor);
    // An autosave of the pre-rename text, queued while the rename ran.
    const stale = queue.save("# Old\nBody typed");
    task.resolve();
    await ran;
    await stale;

    expect(writes).toEqual(["# New\nBody typed"]);
    expect(queue.saved).toBe("# New\nBody typed");

    // Saves queued after the task settled write their own text, as before.
    await queue.save("# New\nBody typed more");
    expect(writes).toEqual(["# New\nBody typed", "# New\nBody typed more"]);
  });

  it("drops a save queued during a task when the current text is already saved", async () => {
    const task = deferred();
    const writes: string[] = [];
    const queue = createSaveQueue("# Old", async (text) => {
      writes.push(text);
    });
    const ran = queue.run(async () => {
      await task.promise;
      queue.markSaved("# New");
    }, () => "# New");
    const stale = queue.save("# Old typed");
    task.resolve();
    await Promise.all([ran, stale]);
    expect(writes).toEqual([]);
  });
});
