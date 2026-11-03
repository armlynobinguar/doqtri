import { describe, expect, it, vi } from "vitest";
import { memoize, once, runCheck, runChecks } from "./run-check";
import type { OpsCheckDef, OpsResult } from "./types";

const def = (id: string, run: () => Promise<OpsResult>): OpsCheckDef => ({ id, section: "health", label: id, run });

describe("runCheck", () => {
  it("passes a check's answer through with its id, section and label", async () => {
    const check = await runCheck(def("a", async () => ({ status: "ok", value: "fine" })));
    expect(check).toEqual({ id: "a", section: "health", label: "a", status: "ok", value: "fine" });
  });

  it("reads a check that does not answer in time as unknown, without waiting for it", async () => {
    const started = Date.now();
    const check = await runCheck(def("slow", () => new Promise(() => {})), 50);
    expect(check).toMatchObject({ status: "unknown", detail: "No answer within 0.05 s" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reads a check that throws as unknown, and never shows what it threw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secretUrl = "https://rpc.example.com/v1/sk_live_SECRET";
    const check = await runCheck(def("boom", async () => Promise.reject(new Error(`fetch ${secretUrl} failed`))));
    expect(check.status).toBe("unknown");
    expect(JSON.stringify(check)).not.toContain("SECRET");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("runChecks", () => {
  it("answers every other check when one hangs and one throws, worst first", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const checks = await runChecks(
      [
        def("ok", async () => ({ status: "ok", value: "1" })),
        def("hangs", () => new Promise(() => {})),
        def("warn", async () => ({ status: "warn", value: "2" })),
        def("throws", async () => {
          throw new Error("down");
        }),
        def("crit", async () => ({ status: "crit", value: "3" })),
      ],
      50,
    );
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["crit", "crit"],
      ["hangs", "unknown"],
      ["throws", "unknown"],
      ["warn", "warn"],
      ["ok", "ok"],
    ]);
    vi.restoreAllMocks();
  });
});

describe("memoize", () => {
  it("reuses an answer for its key until it is ttlMs old", async () => {
    let now = 0;
    const load = vi.fn(async (key: string) => `${key}@${now}`);
    const cached = memoize(load, 1000, () => now);
    expect(await cached("a")).toBe("a@0");
    now = 999;
    expect(await cached("a")).toBe("a@0");
    expect(await cached("b")).toBe("b@999");
    now = 1000;
    expect(await cached("a")).toBe("a@1000");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not remember a failure", async () => {
    let fail = true;
    const cached = memoize(async () => {
      if (fail) throw new Error("down");
      return "up";
    }, 60_000);
    await expect(cached("a")).rejects.toThrow("down");
    fail = false;
    expect(await cached("a")).toBe("up");
  });
});

describe("once", () => {
  it("starts the load once for every caller", async () => {
    const load = vi.fn(async () => 42);
    const shared = once(load);
    expect(await Promise.all([shared(), shared(), shared()])).toEqual([42, 42, 42]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
