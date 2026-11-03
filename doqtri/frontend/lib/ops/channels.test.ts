import { afterEach, describe, expect, it, vi } from "vitest";
import { sortChannels } from "@/components/admin/ops-channels";
import { channelSection, readChannelRows } from "./channels";
import { collectOps } from "./collect";
import type { OpsDeps, RelayChannelRow } from "./deps";
import type { OpsChannel } from "./types";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const key = (c: string) => `G${c.repeat(55)}`;

function deps(balances: Record<string, number | "missing" | "error">, rows?: RelayChannelRow[]): OpsDeps {
  const channels =
    rows ?? Object.keys(balances).map((c, idx) => ({ idx, publicKey: key(c), leasedUntil: null as string | null }));
  return {
    now: () => NOW,
    config: {
      network: "testnet",
      relayer: null,
      registry: "CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ",
      market: null,
      feeForwarder: null,
      horizonUrl: "https://horizon-testnet.stellar.org",
      registryEditors: false,
      dedicatedRpc: false,
      expertApiUrl: "https://api.stellar.expert/x",
    },
    snapshot: async () => {
      throw new Error("not in these tests");
    },
    channels: async () => channels,
    balance: async (address) => {
      const value = balances[address[1]];
      if (value === "error") throw new Error("Horizon 429");
      if (value === "missing") return { funded: false };
      return { funded: true, balance: value, spendable: value };
    },
    contractTtl: async () => null,
    rpcHealth: async () => ({ status: "healthy", latestLedger: 1 }),
    fetch: (async () => new Response("", { status: 400 })) as typeof fetch,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readChannelRows", () => {
  it("rates each channel on the fee-payer limits: crit below 1,000, warn below 2,000", async () => {
    const rows = await readChannelRows(deps({ A: 999.99, B: 1000, C: 1999, D: 2000 }));
    expect(rows.map((r) => [r.idx, r.xlm, r.status])).toEqual([
      [0, 999.99, "crit"],
      [1, 1000, "warn"],
      [2, 1999, "warn"],
      [3, 2000, "ok"],
    ]);
    expect(rows[0].explorerUrl).toBe(`https://stellar.expert/explorer/testnet/account/${key("A")}`);
  });

  it("a channel with no account is crit; an unreadable balance is unknown on its own row", async () => {
    const rows = await readChannelRows(deps({ A: "missing", B: "error", C: 5000 }));
    expect(rows.map((r) => [r.xlm, r.status])).toEqual([
      [null, "crit"],
      [null, "unknown"],
      [5000, "ok"],
    ]);
  });

  it("shows a lease only while it lasts", async () => {
    const rows = await readChannelRows(
      deps({ A: 5000, B: 5000 }, [
        { idx: 0, publicKey: key("A"), leasedUntil: new Date(NOW + 30_000).toISOString() },
        { idx: 1, publicKey: key("B"), leasedUntil: new Date(NOW - 30_000).toISOString() },
      ]),
    );
    expect(rows.map((r) => r.leasedUntil)).toEqual([new Date(NOW + 30_000).toISOString(), null]);
  });
});

describe("channelSection", () => {
  it("reports the pool state and the limits with the rows", async () => {
    vi.stubEnv("RELAY_POOL", "on");
    const section = await channelSection(deps({ A: 5000 }));
    expect(section).toMatchObject({ ok: true, poolOn: true, limits: { warn: 2000, crit: 1000 } });
  });

  it("says why when the channel list does not answer in time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const slow = { ...deps({}), channels: () => new Promise<RelayChannelRow[]>(() => {}) };
    const section = await channelSection(slow, 50);
    expect(section).toEqual({ ok: false, error: "Could not read the relay channels within 0.05 s; see the server log" });
  });
});

describe("collectOps", () => {
  it("reads the channel list and each balance once, for the check and the table together", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = deps({ A: 500, B: 5000 });
    const channels = vi.fn(base.channels);
    const balance = vi.fn(base.balance);
    const report = await collectOps({ ...base, channels, balance }, 200);
    expect(channels).toHaveBeenCalledTimes(1);
    expect(balance.mock.calls.map(([address]) => address).sort()).toEqual([key("A"), key("B")]);
    expect(report.channels).toMatchObject({ ok: true, rows: [{ idx: 0, status: "crit" }, { idx: 1, status: "ok" }] });
    expect(report.checks.find((c) => c.id === "channel-balances")).toMatchObject({ status: "warn", value: "min 500 XLM" });
  });

  it("an unreadable channel does not hide the others in the summary", async () => {
    vi.stubEnv("RELAY_POOL", "on");
    const report = await collectOps(deps({ A: "error", B: 5000 }), 200);
    const check = report.checks.find((c) => c.id === "channel-balances");
    expect(check).toMatchObject({ status: "warn", value: "min 5,000 XLM" });
    expect(check?.detail).toMatch(/1 unreadable/);
  });
});

describe("sortChannels", () => {
  const row = (idx: number, xlm: number | null, status: OpsChannel["status"]): OpsChannel => ({
    idx,
    publicKey: key("A"),
    explorerUrl: "",
    xlm,
    status,
    leasedUntil: null,
  });

  it("by index, or lowest first with missing accounts first and unreadable ones last", () => {
    const rows = [row(0, 3000, "ok"), row(1, null, "unknown"), row(2, 500, "crit"), row(3, null, "crit"), row(4, 500, "crit")];
    expect(sortChannels(rows, "index").map((r) => r.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(sortChannels(rows, "lowest").map((r) => r.idx)).toEqual([3, 2, 4, 0, 1]);
  });
});
