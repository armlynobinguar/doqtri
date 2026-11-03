import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsBoard, REFRESH_MS } from "@/components/admin/ops-board";
import type { OpsCheck, OpsReport } from "@/lib/ops/types";

/*
 * What /admin/ops renders from a report (DOQ-14). Static markup: the unit
 * tests run in Node without a DOM, so the minute timer is pinned by its
 * constant rather than run.
 */

const check = (over: Partial<OpsCheck> & Pick<OpsCheck, "id" | "section" | "status">): OpsCheck => ({
  label: over.id,
  value: "v",
  ...over,
});

const report: OpsReport = {
  generatedAt: "2026-11-03T12:00:00.000Z",
  environment: "production",
  network: "testnet",
  commit: "0d479492",
  checks: [
    check({ id: "cron", section: "health", status: "crit", label: "CRON_SECRET", value: "Unset", detail: "GET /api/chain/jobs refuses every call" }),
    check({ id: "relayer", section: "spendable", status: "warn", label: "Relayer XLM", value: "1,500 XLM", threshold: "warn < 2,000 · crit < 1,000" }),
    check({ id: "jobs", section: "statuses", status: "ok", label: "Chain jobs pending" }),
    check({ id: "qdit", section: "statuses", status: "off", label: "qdit connections" }),
  ],
  channels: {
    ok: true,
    poolOn: false,
    limits: { warn: 2000, crit: 1000 },
    rows: [
      { idx: 0, publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", explorerUrl: "https://stellar.expert/explorer/testnet/account/GAAA", xlm: 9990, status: "ok", leasedUntil: null },
      { idx: 1, publicKey: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", explorerUrl: "https://stellar.expert/explorer/testnet/account/GBBB", xlm: 640.5, status: "crit", leasedUntil: "2026-11-03T12:00:45.000Z" },
    ],
  },
};

const billing = [{ label: "OpenAI usage", href: "https://platform.openai.com/usage" }];

describe("OpsBoard", () => {
  const html = renderToStaticMarkup(createElement(OpsBoard, { initial: report, billing }));

  it("shows the deployment it describes", () => {
    expect(html).toContain("production");
    expect(html).toContain("testnet");
    expect(html).toContain("0d479492");
  });

  it("has the three sections in order, then billing links", () => {
    const at = (text: string) => html.indexOf(text);
    expect(at(">Spendable<")).toBeGreaterThan(-1);
    expect(at(">Spendable<")).toBeLessThan(at(">Statuses<"));
    expect(at(">Statuses<")).toBeLessThan(at(">Health<"));
    expect(at(">Health<")).toBeLessThan(at(">Billing<"));
    expect(html).toContain('href="https://platform.openai.com/usage"');
  });

  it("shows each check's value, status, detail and threshold", () => {
    expect(html).toContain("Relayer XLM");
    expect(html).toContain("1,500 XLM");
    expect(html).toContain("warn &lt; 2,000 · crit &lt; 1,000");
    expect(html).toContain("GET /api/chain/jobs refuses every call");
    expect(html).toMatch(/1 crit/);
  });

  it("lists every relay channel under Spendable, with its balance, status and lease", () => {
    expect(html.indexOf(">Relay channels<")).toBeGreaterThan(html.indexOf(">Spendable<"));
    expect(html.indexOf(">Relay channels<")).toBeLessThan(html.indexOf(">Statuses<"));
    expect(html).toContain('href="https://stellar.expert/explorer/testnet/account/GBBB"');
    expect(html).toContain("GBBB…BBBB");
    expect(html).toContain("640.50 XLM");
    expect(html).toContain("9,990.00 XLM");
    expect(html).toContain("until 12:00:45 UTC");
    expect(html).toMatch(/2 channels · lowest 641 XLM · total 10,631 XLM · 1 below 1,000 XLM · 1 leased/);
  });

  it("says so when the channels could not be read", () => {
    const failed = renderToStaticMarkup(
      createElement(OpsBoard, { initial: { ...report, channels: { ok: false, error: "Could not read the relay channels" } }, billing }),
    );
    expect(failed).toContain("Could not read the relay channels");
    expect(failed).toContain("Relayer XLM");
  });

  it("has a manual refresh, and asks again every minute", () => {
    expect(html).toContain("Refresh");
    expect(REFRESH_MS).toBe(60_000);
  });
});
