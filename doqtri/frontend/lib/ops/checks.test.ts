import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { collectOps, opsCheckDefs } from "./collect";
import type { ContractTtl, OpsDeps, OpsSnapshot } from "./deps";
import { runCheck } from "./run-check";
import type { OpsResult } from "./types";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const RELAYER = Keypair.random();
const REGISTRY = "CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ";
const LEGACY_REGISTRY = "CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB";

function snapshot(over: Partial<OpsSnapshot> = {}): OpsSnapshot {
  return {
    at: ago(0),
    chain_jobs: { pending: 0, needs_product_owner: 0, failed: 0, failed_24h: 0, oldest_pending_at: null },
    wallet_topups: { pending: 0, failed: 0, failed_24h: 0, oldest_pending_at: null },
    chain_writes: { pending: 0, oldest_pending_at: null, failed_24h: 0 },
    relay_channels: [],
    chain_usage_24h: [],
    ai_usage_24h: { total: 0, by_route: {}, top_user: 0 },
    ingests: { total_24h: 0, failed_24h: 0, stuck_pending: 0 },
    qdit: { connections: {}, webhooks_late: 0 },
    moderation: { templates_pending: 0, reports_open: 0, promo_pending: 0, promo_rating_errors: 0 },
    doc_locks: { active: 0, stale: 0 },
    storage: { db_bytes: 100 * 1024 ** 2, buckets: { uploads: 1024 } },
    scheduler: { status: "configured", job: true, missing_secrets: [] },
    cron: {
      last_run: { status: "succeeded", start_time: ago(30), end_time: ago(29), message: "1 row" },
      last_http: { status_code: 200, timed_out: false, error: null, created: ago(29) },
    },
    ...over,
  };
}

type Routes = Record<string, () => Response>;

function fakeDeps(over: Partial<OpsDeps> = {}, routes: Routes = {}): OpsDeps & { calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const defaults: Routes = {
    "https://horizon-testnet.stellar.org": () =>
      Response.json({ history_latest_ledger: 123, history_latest_ledger_closed_at: ago(4) }),
    "https://friendbot.stellar.org/": () => new Response("missing addr", { status: 400 }),
    "https://api.openai.com/v1/models": () => Response.json({ data: [] }),
    "https://api.github.com/rate_limit": () =>
      Response.json({ resources: { core: { limit: 5000, remaining: 4000, reset: NOW / 1000 + 600 } } }),
    "https://api.stellar.expert/x": () => Response.json({}),
  };
  const table = { ...defaults, ...routes };
  return {
    calls,
    now: () => NOW,
    config: {
      network: "testnet",
      relayer: RELAYER.publicKey(),
      registry: REGISTRY,
      market: "CA6YPRXQ2IFGACBFLKWEFETGLZ2C5R7DG5TTBKTTP4AVYOF3HFOSBCC2",
      feeForwarder: "CCBBXJSS7DUT34QDJOMZLAYMYOT4Q73NUSY573G4STXFUBSYXDKUBUHV",
      horizonUrl: "https://horizon-testnet.stellar.org",
      registryEditors: false,
      dedicatedRpc: false,
      expertApiUrl: "https://api.stellar.expert/x",
    },
    snapshot: async () => snapshot(),
    channels: async () => [],
    balance: async () => ({ funded: true, balance: 9000, spendable: 9000 }),
    contractTtl: async (): Promise<ContractTtl> => ({ latestLedger: 1000, instanceLiveUntil: 1000 + 17280 * 60, codeLiveUntil: 1000 + 17280 * 90 }),
    rpcHealth: async () => ({ status: "healthy", latestLedger: 123 }),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      const route = table[url];
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route();
    }) as typeof fetch,
    ...over,
  };
}

async function check(id: string, deps: OpsDeps): Promise<OpsResult> {
  const def = opsCheckDefs(deps).find((d) => d.id === id);
  if (!def) throw new Error(`no check ${id}`);
  const { status, value, threshold, detail } = await runCheck(def);
  return { status, value, threshold, detail };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret-value");
  vi.stubEnv("DOQTRI_RELAYER_SECRET", RELAYER.secret());
  vi.stubEnv("CHANNELS_API_KEY", "channels-key-value");
  vi.stubEnv("OPENAI_API_KEY", "sk-openai-value");
  vi.stubEnv("GITHUB_TOKEN", "ghp_token_value");
  vi.stubEnv("RELAY_POOL", "");
  vi.stubEnv("RELAY_CHANNEL_SEED", "");
  vi.stubEnv("REVOKER_SECRET_KEY", "");
  vi.stubEnv("CONTRACT_ADMIN_SECRET", "");
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
  vi.stubEnv("NEXT_PUBLIC_CONTRACT_ID", "");
  vi.stubEnv("AI_DAILY_LIMIT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("spendable", () => {
  it("relayer XLM: crit below 1,000, warn below 2,000, ok from 2,000", async () => {
    const at = (spendable: number) => fakeDeps({ balance: async () => ({ funded: true, balance: spendable, spendable }) });
    expect((await check("relayer-balance", at(999))).status).toBe("crit");
    expect((await check("relayer-balance", at(1000))).status).toBe("warn");
    expect((await check("relayer-balance", at(1999))).status).toBe("warn");
    const ok = await check("relayer-balance", at(2000));
    expect(ok.status).toBe("ok");
    expect(ok.value).toBe("2,000 XLM");
    expect(ok.detail).toMatch(/refills from Friendbot/);
  });

  it("relayer: crit when the account does not exist, off with no relayer", async () => {
    expect((await check("relayer-balance", fakeDeps({ balance: async () => ({ funded: false }) }))).status).toBe("crit");
    const deps = fakeDeps();
    deps.config.relayer = null;
    expect((await check("relayer-balance", deps)).status).toBe("off");
  });

  it("channels: off with the pool off and none seeded, crit with the pool on and none seeded", async () => {
    expect((await check("channel-balances", fakeDeps())).status).toBe("off");
    vi.stubEnv("RELAY_POOL", "on");
    expect((await check("channel-balances", fakeDeps())).status).toBe("crit");
  });

  it("channels: the lowest balance decides, and the count below the floor is shown", async () => {
    vi.stubEnv("RELAY_POOL", "on");
    const balances: Record<string, number> = { A: 5000, B: 500, C: 3000 };
    const deps = fakeDeps({
      channels: async () => ["A", "B", "C"].map((publicKey, idx) => ({ idx, publicKey, leasedUntil: null })),
      balance: async (key) => ({ funded: true, balance: balances[key], spendable: balances[key] }),
    });
    const result = await check("channel-balances", deps);
    expect(result).toMatchObject({ status: "crit", value: "min 500 XLM" });
    expect(result.detail).toMatch(/3 channels, 1 below 1,000 XLM/);
  });

  it("revoker: crit when registry editors are on without it, off otherwise", async () => {
    expect((await check("revoker-balance", fakeDeps())).status).toBe("off");
    const deps = fakeDeps();
    deps.config.registryEditors = true;
    expect((await check("revoker-balance", deps)).status).toBe("crit");
  });

  it("chain quota: warn at 70% of the global cap, crit at 90%", async () => {
    const at = (count: number) =>
      fakeDeps({ snapshot: async () => snapshot({ chain_usage_24h: [{ network: "testnet", kind: "write", count }] }) });
    expect((await check("quota-write", at(3499))).status).toBe("ok");
    expect((await check("quota-write", at(3500))).status).toBe("warn");
    expect((await check("quota-write", at(4500))).status).toBe("crit");
    expect((await check("quota-write", at(3500))).value).toBe("3,500 / 5,000");
  });

  it("chain quota: another network's use is not counted", async () => {
    const deps = fakeDeps({
      snapshot: async () => snapshot({ chain_usage_24h: [{ network: "mainnet", kind: "write", count: 4999 }] }),
    });
    expect(await check("quota-write", deps)).toMatchObject({ status: "ok", value: "0 / 5,000" });
  });

  it("AI calls: off without a key, warn once a user reaches the daily limit", async () => {
    const at = (top: number) =>
      fakeDeps({ snapshot: async () => snapshot({ ai_usage_24h: { total: 40, by_route: { ingest: 40 }, top_user: top } }) });
    expect((await check("ai-usage", at(29))).status).toBe("ok");
    expect((await check("ai-usage", at(30))).status).toBe("warn");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await check("ai-usage", at(30))).status).toBe("off");
  });

  it("GitHub: warn under 20% left, crit under 5%, crit on a rejected token", async () => {
    const at = (remaining: number) =>
      fakeDeps({}, { "https://api.github.com/rate_limit": () => Response.json({ resources: { core: { limit: 5000, remaining } } }) });
    expect((await check("github-rate-limit", at(1000))).status).toBe("ok");
    expect((await check("github-rate-limit", at(999))).status).toBe("warn");
    expect((await check("github-rate-limit", at(249))).status).toBe("crit");
    const rejected = fakeDeps({}, { "https://api.github.com/rate_limit": () => new Response("", { status: 401 }) });
    expect((await check("github-rate-limit", rejected)).status).toBe("crit");
  });

  it("contract TTL: whichever entry expires first, warn under 30 days, crit under 7", async () => {
    const ledgersPerDay = 17280;
    const at = (instanceDays: number, codeDays: number) =>
      fakeDeps({
        contractTtl: async () => ({
          latestLedger: 1000,
          instanceLiveUntil: 1000 + ledgersPerDay * instanceDays,
          codeLiveUntil: 1000 + ledgersPerDay * codeDays,
        }),
      });
    expect((await check("ttl-registry", at(30, 90))).status).toBe("ok");
    const code = await check("ttl-registry", at(60, 29));
    expect(code).toMatchObject({ status: "warn", value: "29 days" });
    expect(code.detail).toMatch(/code entry expires first/);
    expect((await check("ttl-registry", at(6, 90))).status).toBe("crit");
    expect((await check("ttl-registry", fakeDeps({ contractTtl: async () => null }))).status).toBe("crit");
  });

  it("contract TTL: off for a contract this network does not have", async () => {
    const deps = fakeDeps();
    deps.config.feeForwarder = null;
    expect((await check("ttl-fee-forwarder", deps)).status).toBe("off");
  });

  it("database and file storage against the Pro plan", async () => {
    const gb = 1024 ** 3;
    const deps = fakeDeps({ snapshot: async () => snapshot({ storage: { db_bytes: 6 * gb, buckets: { uploads: 95 * gb } } }) });
    expect((await check("db-size", deps)).status).toBe("warn");
    expect((await check("storage-size", deps)).status).toBe("crit");
    const none = fakeDeps({ snapshot: async () => snapshot({ storage: { db_bytes: gb, buckets: null } }) });
    expect((await check("storage-size", none)).status).toBe("unknown");
  });
});

describe("statuses", () => {
  it("chain jobs: the oldest pending job's age decides", async () => {
    const at = (pending: number, seconds: number | null) =>
      fakeDeps({
        snapshot: async () =>
          snapshot({ chain_jobs: { pending, needs_product_owner: 0, failed: 0, failed_24h: 0, oldest_pending_at: seconds === null ? null : ago(seconds) } }),
      });
    expect((await check("chain-jobs-backlog", at(0, null))).status).toBe("ok");
    expect((await check("chain-jobs-backlog", at(2, 9 * 60))).status).toBe("ok");
    expect((await check("chain-jobs-backlog", at(2, 10 * 60))).status).toBe("warn");
    expect((await check("chain-jobs-backlog", at(2, 60 * 60))).status).toBe("crit");
  });

  it("chain jobs: one needing the product owner, or failed today, wants a person", async () => {
    const deps = fakeDeps({
      snapshot: async () => snapshot({ chain_jobs: { pending: 0, needs_product_owner: 0, failed: 9, failed_24h: 0, oldest_pending_at: null } }),
    });
    expect((await check("chain-jobs-attention", deps)).status).toBe("ok");
    const recent = fakeDeps({
      snapshot: async () => snapshot({ chain_jobs: { pending: 0, needs_product_owner: 1, failed: 9, failed_24h: 0, oldest_pending_at: null } }),
    });
    expect((await check("chain-jobs-attention", recent)).status).toBe("warn");
  });

  it("paid writes: pending past 120 s warns, past 600 s is crit, 25 failures today are crit", async () => {
    const at = (seconds: number, failed = 0) =>
      fakeDeps({ snapshot: async () => snapshot({ chain_writes: { pending: 1, oldest_pending_at: ago(seconds), failed_24h: failed } }) });
    expect((await check("pending-writes", at(119))).status).toBe("ok");
    expect((await check("pending-writes", at(120))).status).toBe("warn");
    expect((await check("pending-writes", at(600))).status).toBe("crit");
    expect((await check("pending-writes", at(10, 25))).status).toBe("crit");
  });

  it("imports: the failure rate counts from 5 imports; a stuck one warns", async () => {
    const at = (total: number, failed: number, stuck = 0) =>
      fakeDeps({ snapshot: async () => snapshot({ ingests: { total_24h: total, failed_24h: failed, stuck_pending: stuck } }) });
    expect((await check("ingests", at(4, 3))).status).toBe("ok");
    expect((await check("ingests", at(5, 1))).status).toBe("warn");
    expect((await check("ingests", at(10, 5))).status).toBe("crit");
    expect((await check("ingests", at(10, 0, 1))).status).toBe("warn");
  });

  it("relay channels leased: off with the pool off, crit when every channel is leased", async () => {
    const deps = fakeDeps({ snapshot: async () => snapshot({ relay_channels: [{ network: "testnet", total: 40, leased: 40 }] }) });
    expect((await check("channel-leases", deps)).status).toBe("off");
    vi.stubEnv("RELAY_POOL", "on");
    expect((await check("channel-leases", deps)).status).toBe("crit");
  });

  it("qdit checks are off while the integration is off", async () => {
    const deps = fakeDeps({ snapshot: async () => snapshot({ qdit: { connections: { needs_reconnect: 9 }, webhooks_late: 50 } }) });
    expect((await check("qdit-connections", deps)).status).toBe("off");
    expect((await check("qdit-webhooks", deps)).status).toBe("off");
  });

  it("an open template report warns", async () => {
    const deps = fakeDeps({
      snapshot: async () => snapshot({ moderation: { templates_pending: 0, reports_open: 1, promo_pending: 0, promo_rating_errors: 0 } }),
    });
    expect((await check("template-reports", deps)).status).toBe("warn");
  });

  it("every status check reads as unknown when the snapshot fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = fakeDeps({ snapshot: async () => Promise.reject(new Error("db down")) });
    const statuses = opsCheckDefs(deps).filter((d) => d.section === "statuses");
    for (const def of statuses) expect((await runCheck(def)).status).toBe("unknown");
  });
});

describe("health", () => {
  it("scheduler: crit when a Vault secret is missing", async () => {
    const deps = fakeDeps({
      snapshot: async () => snapshot({ scheduler: { status: "missing", job: true, missing_secrets: ["doqtri_cron_secret"] } }),
    });
    const result = await check("scheduler", deps);
    expect(result.status).toBe("crit");
    expect(result.detail).toMatch(/doqtri_cron_secret/);
  });

  it("last pg_cron run: crit when it stopped or failed", async () => {
    const at = (status: string, seconds: number) =>
      fakeDeps({
        snapshot: async () =>
          snapshot({
            cron: {
              last_run: { status, start_time: ago(seconds), end_time: null, message: "boom" },
              last_http: { status_code: 200, timed_out: false, error: null, created: ago(seconds) },
            },
          }),
      });
    expect((await check("cron-last-run", at("succeeded", 60))).status).toBe("ok");
    expect((await check("cron-last-run", at("running", 20))).status).toBe("ok");
    expect((await check("cron-last-run", at("starting", 1))).status).toBe("ok");
    expect((await check("cron-last-run", at("succeeded", 200))).status).toBe("crit");
    expect((await check("cron-last-run", at("running", 200))).status).toBe("crit");
    expect((await check("cron-last-run", at("failed", 30))).status).toBe("crit");
  });

  it("a failed run's message reaches the page without URLs or bearer tokens", async () => {
    const deps = fakeDeps({
      snapshot: async () =>
        snapshot({
          cron: {
            last_run: {
              status: "failed",
              start_time: ago(30),
              end_time: null,
              message: "ERROR: GET https://www.doqtri.xyz/api/chain/jobs?k=1 with Bearer abc.def failed",
            },
            last_http: null,
          },
        }),
    });
    const result = await check("cron-last-run", deps);
    expect(result.detail).toBe("ERROR: GET [url] with Bearer [redacted] failed");
  });

  it("last pg_net call: a 200 long ago means the calls stopped", async () => {
    const at = (seconds: number) =>
      fakeDeps({
        snapshot: async () =>
          snapshot({ cron: { last_run: null, last_http: { status_code: 200, timed_out: false, error: null, created: ago(seconds) } } }),
      });
    expect((await check("cron-last-http", at(60))).status).toBe("ok");
    expect((await check("cron-last-http", at(5 * 3600))).status).toBe("crit");
  });

  it("last pg_net call: a 401 names the CRON_SECRET mismatch", async () => {
    const deps = fakeDeps({
      snapshot: async () =>
        snapshot({ cron: { last_run: null, last_http: { status_code: 401, timed_out: false, error: null, created: ago(30) } } }),
    });
    const result = await check("cron-last-http", deps);
    expect(result.status).toBe("crit");
    expect(result.detail).toMatch(/CRON_SECRET/);
  });

  it("CRON_SECRET unset is crit", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await check("config-cron-secret", fakeDeps())).status).toBe("crit");
  });

  it("relayer key: ok when it matches, crit when it names another account or is malformed", async () => {
    expect((await check("config-relayer-key", fakeDeps()))).toMatchObject({ status: "ok", value: "Matches" });
    vi.stubEnv("DOQTRI_RELAYER_SECRET", Keypair.random().secret());
    expect((await check("config-relayer-key", fakeDeps()))).toMatchObject({ status: "crit", value: "Mismatch" });
    vi.stubEnv("DOQTRI_RELAYER_SECRET", "not-a-key");
    expect((await check("config-relayer-key", fakeDeps()))).toMatchObject({ status: "crit", value: "Malformed" });
  });

  it("a legacy NEXT_PUBLIC_CONTRACT_ID warns", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONTRACT_ID", LEGACY_REGISTRY);
    expect((await check("config-contract-id", fakeDeps())).status).toBe("warn");
  });

  it("relay pool on without a long enough seed is crit", async () => {
    vi.stubEnv("RELAY_POOL", "on");
    vi.stubEnv("RELAY_CHANNEL_SEED", "short");
    expect((await check("config-relay-pool", fakeDeps())).status).toBe("crit");
    vi.stubEnv("RELAY_CHANNEL_SEED", "x".repeat(32));
    expect((await check("config-relay-pool", fakeDeps())).status).toBe("ok");
  });

  it("qdit: reachable is ok, a 404 on the configured path warns", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
    vi.stubEnv("QDIT_API_BASE_URL", "https://qdit.test/api/v1");
    vi.stubEnv("QDIT_OAUTH_ISSUER", "https://auth.qdit.test/auth/v1");
    vi.stubEnv("QDIT_OAUTH_CLIENT_ID", "client");
    vi.stubEnv("QDIT_CLIENT_SECRET", "secret");
    vi.stubEnv("INTEGRATION_TOKEN_KEY", "key");
    const at = (apiStatus: number) =>
      fakeDeps(
        {},
        {
          "https://qdit.test/api/v1/me": () => new Response("", { status: apiStatus }),
          "https://auth.qdit.test/auth/v1/health": () => new Response("", { status: 401 }),
        },
      );
    expect((await check("qdit-api", at(401))).status).toBe("ok");
    expect((await check("qdit-api", at(404))).status).toBe("warn");
    expect((await check("qdit-api", at(503))).status).toBe("crit");
  });

  it("OpenAI: a rejected key is crit", async () => {
    const deps = fakeDeps({}, { "https://api.openai.com/v1/models": () => new Response("", { status: 401 }) });
    expect((await check("openai", deps)).status).toBe("crit");
  });

  it("OpenAI: probes OPENAI_BASE_URL when it is set, as the SDK does (DOQ-18)", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:4020/v1/");
    try {
      const deps = fakeDeps({}, { "http://localhost:4020/v1/models": () => Response.json({ data: [] }) });
      expect((await check("openai", deps)).status).toBe("ok");
      expect(deps.calls.map((c) => c.url)).toContain("http://localhost:4020/v1/models");
      expect(deps.calls.map((c) => c.url)).not.toContain("https://api.openai.com/v1/models");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("Horizon: the last ledger's age decides", async () => {
    const at = (seconds: number) =>
      fakeDeps({}, { "https://horizon-testnet.stellar.org": () => Response.json({ history_latest_ledger_closed_at: ago(seconds) }) });
    expect((await check("horizon", at(5))).status).toBe("ok");
    expect((await check("horizon", at(30))).status).toBe("warn");
    expect((await check("horizon", at(150))).status).toBe("crit");
  });

  it("Soroban RPC: crit when not healthy, never naming its URL", async () => {
    const deps = fakeDeps({ rpcHealth: async () => ({ status: "unhealthy", latestLedger: 0 }) });
    deps.config.dedicatedRpc = true;
    const result = await check("soroban-rpc", deps);
    expect(result).toMatchObject({ status: "crit", detail: "dedicated SOROBAN_RPC_URL" });
  });
});

describe("the whole report", () => {
  it("holds no secret, keyed URL or private key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SOROBAN_RPC_URL", "https://rpc.example.com/key/rpc-key-value");
    vi.stubEnv("RELAY_POOL", "on");
    vi.stubEnv("RELAY_CHANNEL_SEED", "seed-value-".repeat(4));
    const deps = fakeDeps({
      // A dependency whose error quotes the keyed URL.
      rpcHealth: async () => Promise.reject(new Error("GET https://rpc.example.com/key/rpc-key-value failed")),
    });
    const text = JSON.stringify(await collectOps(deps));
    for (const secret of [
      RELAYER.secret(),
      "cron-secret-value",
      "channels-key-value",
      "sk-openai-value",
      "ghp_token_value",
      "rpc-key-value",
      "seed-value-",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("probes with GETs only and funds nothing", async () => {
    const deps = fakeDeps();
    await collectOps(deps);
    expect(deps.calls.length).toBeGreaterThan(0);
    for (const call of deps.calls) {
      expect(call.method).toBe("GET");
      expect(call.url).not.toMatch(/[?&]addr=/);
    }
  });

  it("has a check in every section, and lists them worst first", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const report = await collectOps(fakeDeps());
    expect(new Set(report.checks.map((c) => c.section))).toEqual(new Set(["spendable", "statuses", "health"]));
    expect(report.checks[0].status).toBe("crit");
    expect(report).toMatchObject({ network: "testnet", generatedAt: "2026-11-03T12:00:00.000Z" });
  });
});
