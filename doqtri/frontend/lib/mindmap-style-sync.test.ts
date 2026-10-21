import { describe, expect, it } from "vitest";
import { applyPreset, defaultStyleFor, type MindmapStyle } from "@/lib/mindmap-style";
import { createStyleStore, LOCAL_PREFIX, type SavedStyle } from "@/lib/mindmap-style-sync";

const FALLBACK = defaultStyleFor("radial");
const NEON = applyPreset(FALLBACK, "neon");
const PAPER = applyPreset(FALLBACK, "paper");
const USER = "user-1";
const PENDING = `mindmap-style-pending:${USER}:global`;

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

/** A store on hand-driven timers and a fake server, so tests decide when time passes. */
function harness(options: { storage?: ReturnType<typeof memoryStorage>; fail?: boolean } = {}) {
  const storage = options.storage ?? memoryStorage();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let version = 0;
  const saves: { scope: string; style: MindmapStyle }[] = [];
  let release: (() => void) | null = null;
  const server = { fail: options.fail ?? false, hold: false };

  const store = createStyleStore({
    storage: () => storage,
    save: async ({ scope, style }) => {
      saves.push({ scope, style });
      if (server.hold) await new Promise<void>((resolve) => (release = resolve));
      if (server.fail) throw new Error("offline");
      version += 1;
      return `2026-10-21T10:00:0${version}.000000+00:00`;
    },
    setTimer: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
  });

  async function tick() {
    const due = [...timers.values()];
    timers.clear();
    due.forEach((callback) => callback());
    await Promise.resolve();
    await Promise.resolve();
  }

  return { store, storage, saves, server, tick, timers, release: () => release?.() };
}

function saved(overrides: Partial<SavedStyle> = {}): SavedStyle {
  return { userId: USER, style: null, updatedAt: null, loaded: true, ...overrides };
}

describe("mindmap style sync", () => {
  it("opens with the user's row", () => {
    const { store } = harness();
    const row = saved({ style: NEON, updatedAt: "2026-10-20T00:00:00+00:00" });
    expect(store.read("global", FALLBACK, row).preset).toBe("neon");
  });

  it("saves a moment after the last change, not on every change", async () => {
    const { store, saves, tick, storage } = harness();
    const row = saved();
    store.read("global", FALLBACK, row);

    store.write("global", NEON, row);
    store.write("global", PAPER, row);
    expect(saves).toHaveLength(0);
    // Parked until the server has it.
    expect(storage.map.has(PENDING)).toBe(true);

    await tick();
    expect(saves).toHaveLength(1);
    expect(saves[0].style.preset).toBe("paper");
    expect(storage.map.has(PENDING)).toBe(false);
  });

  it("sends again when the style changed while a save was out", async () => {
    const { store, saves, tick, server, release, storage } = harness();
    const row = saved();
    store.read("global", FALLBACK, row);
    server.hold = true;

    store.write("global", NEON, row);
    await tick();
    store.write("global", PAPER, row);
    server.hold = false;
    release();
    await tick();
    await tick();

    expect(saves.map((s) => s.style.preset)).toEqual(["neon", "paper"]);
    expect(storage.map.has(PENDING)).toBe(false);
  });

  it("keeps a failed edit parked and replays it on the next visit", async () => {
    const storage = memoryStorage();
    const first = harness({ storage, fail: true });
    const row = saved();
    first.store.read("global", FALLBACK, row);
    first.store.write("global", NEON, row);
    await first.tick();
    expect(first.saves).toHaveLength(1);
    expect(storage.map.has(PENDING)).toBe(true);

    const second = harness({ storage });
    expect(second.store.read("global", FALLBACK, row).preset).toBe("neon");
    second.store.resume("global", row);
    await second.tick();
    expect(second.saves.map((s) => s.style.preset)).toEqual(["neon"]);
    expect(storage.map.has(PENDING)).toBe(false);
  });

  it("drops a parked edit when another device saved after it", () => {
    const storage = memoryStorage({
      [PENDING]: JSON.stringify({ style: NEON, base: "2026-10-20T00:00:00+00:00" }),
    });
    const { store } = harness({ storage });
    const row = saved({ style: PAPER, updatedAt: "2026-10-21T00:00:00+00:00" });

    expect(store.read("global", FALLBACK, row).preset).toBe("paper");
    expect(storage.map.has(PENDING)).toBe(false);
  });

  it("takes over a style this browser kept from before, when there is no row", async () => {
    const storage = memoryStorage({ [`${LOCAL_PREFIX}global`]: JSON.stringify(NEON) });
    const { store, saves, tick } = harness({ storage });
    const row = saved();

    expect(store.read("global", FALLBACK, row).preset).toBe("neon");
    expect(storage.map.has(`${LOCAL_PREFIX}global`)).toBe(false);
    store.resume("global", row);
    await tick();
    expect(saves.map((s) => s.style.preset)).toEqual(["neon"]);
  });

  it("does not upload a kept style that is just the default look", async () => {
    const storage = memoryStorage({ [`${LOCAL_PREFIX}global`]: JSON.stringify(FALLBACK) });
    const { store, saves, tick } = harness({ storage });
    const row = saved();

    store.read("global", FALLBACK, row);
    store.resume("global", row);
    await tick();
    expect(saves).toHaveLength(0);
    expect(storage.map.has(`${LOCAL_PREFIX}global`)).toBe(false);
  });

  it("prefers the row over a kept browser style", () => {
    const storage = memoryStorage({ [`${LOCAL_PREFIX}global`]: JSON.stringify(NEON) });
    const { store } = harness({ storage });
    const row = saved({ style: PAPER, updatedAt: "2026-10-21T00:00:00+00:00" });

    expect(store.read("global", FALLBACK, row).preset).toBe("paper");
    expect(storage.map.has(`${LOCAL_PREFIX}global`)).toBe(false);
  });

  it("leaves a kept browser style alone when the row could not be read", async () => {
    const storage = memoryStorage({ [`${LOCAL_PREFIX}global`]: JSON.stringify(NEON) });
    const { store, saves, tick } = harness({ storage });
    const row = saved({ loaded: false });

    expect(store.read("global", FALLBACK, row).preset).toBe(FALLBACK.preset);
    store.resume("global", row);
    await tick();
    expect(saves).toHaveLength(0);
    expect(storage.map.has(`${LOCAL_PREFIX}global`)).toBe(true);
  });

  it("keeps each account's style apart in one tab", () => {
    const { store } = harness();
    const a = saved({ style: NEON, updatedAt: "2026-10-21T00:00:00+00:00" });
    const b = saved({ userId: "user-2", style: PAPER, updatedAt: "2026-10-21T00:00:00+00:00" });

    expect(store.read("global", FALLBACK, a).preset).toBe("neon");
    expect(store.read("global", FALLBACK, b).preset).toBe("paper");
  });

  it("picks up a newer row on returning to a map, but not over unsent edits", () => {
    const { store } = harness();
    const old = saved({ style: NEON, updatedAt: "2026-10-20T00:00:00+00:00" });
    const newer = saved({ style: PAPER, updatedAt: "2026-10-21T00:00:00+00:00" });

    store.read("global", FALLBACK, old);
    expect(store.read("global", FALLBACK, newer).preset).toBe("paper");

    const { store: editing } = harness();
    editing.read("global", FALLBACK, old);
    editing.write("global", applyPreset(FALLBACK, "monochrome"), old);
    expect(editing.read("global", FALLBACK, newer).preset).toBe("monochrome");
  });

  it("keeps maps with no signed-in user in this browser", () => {
    const storage = memoryStorage();
    const { store, saves } = harness({ storage });

    store.read("demo:x", FALLBACK);
    store.write("demo:x", NEON);
    expect(JSON.parse(storage.map.get(`${LOCAL_PREFIX}demo:x`)!).preset).toBe("neon");
    expect(saves).toHaveLength(0);
  });

  it("sends waiting edits at once when the page goes away", async () => {
    const { store, saves, timers } = harness();
    const row = saved();
    store.read("global", FALLBACK, row);
    store.write("global", NEON, row);

    store.flush();
    await Promise.resolve();
    expect(saves).toHaveLength(1);
    expect(timers.size).toBe(0);
  });
});
