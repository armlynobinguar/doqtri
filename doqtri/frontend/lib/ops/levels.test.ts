import { describe, expect, it } from "vitest";
import {
  ageSeconds,
  formatAge,
  formatBytes,
  highIsBad,
  lowIsBad,
  percent,
  shortKey,
  sortChecks,
  worst,
} from "./levels";
import type { OpsCheck, OpsStatus } from "./types";

describe("lowIsBad (what runs out)", () => {
  const limits = { warn: 2000, crit: 1000 };
  it("is crit below crit, warn below warn, ok from warn up", () => {
    expect(lowIsBad(999.99, limits)).toBe("crit");
    expect(lowIsBad(1000, limits)).toBe("warn");
    expect(lowIsBad(1999.99, limits)).toBe("warn");
    expect(lowIsBad(2000, limits)).toBe("ok");
  });
});

describe("highIsBad (what piles up)", () => {
  const limits = { warn: 70, crit: 90 };
  it("is ok below warn, warn from warn, crit from crit", () => {
    expect(highIsBad(69.9, limits)).toBe("ok");
    expect(highIsBad(70, limits)).toBe("warn");
    expect(highIsBad(89.9, limits)).toBe("warn");
    expect(highIsBad(90, limits)).toBe("crit");
  });
});

describe("worst and sortChecks", () => {
  it("ranks crit, then unknown, then warn, ok and off", () => {
    expect(worst(["ok", "warn", "off"])).toBe("warn");
    expect(worst(["warn", "unknown"])).toBe("unknown");
    expect(worst(["unknown", "crit", "ok"])).toBe("crit");
    expect(worst([])).toBe("off");
  });

  it("puts the worst first and keeps the order of equals", () => {
    const check = (id: string, status: OpsStatus): OpsCheck => ({ id, status, section: "health", label: id, value: "" });
    const sorted = sortChecks([check("a", "ok"), check("b", "crit"), check("c", "off"), check("d", "ok"), check("e", "warn")]);
    expect(sorted.map((c) => c.id)).toEqual(["b", "e", "a", "d", "c"]);
  });
});

describe("formatting", () => {
  it("percent of a cap, and 0 for no cap", () => {
    expect(percent(35, 50)).toBe(70);
    expect(percent(3, 0)).toBe(0);
  });

  it("age from an ISO time", () => {
    const now = Date.parse("2026-11-03T10:00:00Z");
    expect(ageSeconds("2026-11-03T09:59:00Z", now)).toBe(60);
    expect(ageSeconds(null, now)).toBeNull();
    expect(ageSeconds("not a date", now)).toBeNull();
    expect(formatAge(45)).toBe("45 s");
    expect(formatAge(600)).toBe("10 min");
    expect(formatAge(7200)).toBe("2 h");
    expect(formatAge(3 * 86400)).toBe("3 d");
  });

  it("bytes and keys", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(8 * 1024 ** 3)).toBe("8 GB");
    expect(shortKey("GCY3QATELG5SQGVV56UF3RIXAFELDQTHP2PFLGG3SFJJETCGBEFUDB5M")).toBe("GCY3…DB5M");
  });
});
