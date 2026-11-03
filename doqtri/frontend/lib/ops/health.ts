import { Keypair } from "@stellar/stellar-sdk";
import { qditConfig, qditIntegrationEnabled, qditWebhookSecret } from "@/lib/integrations/qdit-config";
import { ageSeconds, formatAge, highIsBad, shortKey, worst, type Limits } from "@/lib/ops/levels";
import type { OpsDeps } from "@/lib/ops/deps";
import type { OpsCheckDef, OpsResult, OpsStatus } from "@/lib/ops/types";
import { MIN_SEED_LENGTH } from "@/lib/stellar/channel-accounts.mjs";
import { parseSchedulerHealth, schedulerWarning } from "@/lib/stellar/chain-jobs-scheduler";
import { relayPoolEnabled } from "@/lib/stellar/channel-pool";
import { LEGACY_CONTRACT_IDS } from "@/lib/stellar/config";

/** pg_cron runs every minute; three minutes without a run means it stopped. */
export const CRON_RUN_AGE_SECONDS: Limits = { warn: 120, crit: 180 };
/** Horizon's last closed ledger; ledgers close every ~5 s. */
export const LEDGER_AGE_SECONDS: Limits = { warn: 30, crit: 120 };
/** Round trip of a probe. */
export const PROBE_SLOW_MS = 2_000;

const present = (name: string) => Boolean(process.env[name]?.trim());

/**
 * pg_cron and pg_net messages are the database's own words, but a Postgres
 * error can echo a bound value: URLs and bearer tokens are cut out before
 * they reach a browser.
 */
export function redactMessage(message: string | null | undefined): string | undefined {
  if (!message) return undefined;
  return message
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]");
}

/** Times a probe; any answer under 500 means the service is up (400 and 401 included). */
async function reachable(deps: OpsDeps, url: string, init?: RequestInit): Promise<{ status: number; ms: number }> {
  const started = deps.now();
  const res = await deps.fetch(url, { method: "GET", ...init });
  return { status: res.status, ms: deps.now() - started };
}

function upOrDown(probe: { status: number; ms: number }, downStatus: OpsStatus = "crit"): OpsResult {
  if (probe.status >= 500) return { status: downStatus, value: `HTTP ${probe.status}`, detail: `${probe.ms} ms` };
  return {
    status: probe.ms > PROBE_SLOW_MS ? "warn" : "ok",
    value: `${probe.ms} ms`,
    threshold: `warn > ${PROBE_SLOW_MS / 1000} s`,
    detail: `HTTP ${probe.status}`,
  };
}

function health(id: string, label: string, run: () => Promise<OpsResult>): OpsCheckDef {
  return { id, section: "health", label, run };
}

function schedulerChecks(deps: OpsDeps): OpsCheckDef[] {
  return [
    health("scheduler", "pg_cron scheduler", async () => {
      const scheduler = parseSchedulerHealth((await deps.snapshot()).scheduler);
      const status: OpsStatus =
        scheduler.status === "configured" ? "ok" : scheduler.status === "unknown" ? "unknown" : "crit";
      return {
        status,
        value: scheduler.status,
        detail: schedulerWarning(scheduler) ?? "doqtri-chain-jobs runs every minute",
      };
    }),

    health("cron-last-run", "Last pg_cron run", async () => {
      const { cron, scheduler } = await deps.snapshot();
      const run = cron.last_run;
      if (!run) {
        return parseSchedulerHealth(scheduler).status === "configured"
          ? { status: "warn", value: "None yet", detail: "No run of doqtri-chain-jobs recorded" }
          : { status: "unknown", value: "—", detail: "No pg_cron run log in this database" };
      }
      const age = ageSeconds(run.start_time, deps.now()) ?? Infinity;
      const ageStatus = highIsBad(age, CRON_RUN_AGE_SECONDS);
      // starting and running are a healthy run in flight; only its age can fault it.
      const failed = !["succeeded", "starting", "running"].includes(run.status);
      return {
        status: worst([ageStatus, failed ? "crit" : "ok"]),
        value: `${run.status}, ${Number.isFinite(age) ? `${formatAge(age)} ago` : "time unknown"}`,
        threshold: `every minute · crit when the last run is ≥ ${CRON_RUN_AGE_SECONDS.crit / 60} min old or failed`,
        detail: failed ? redactMessage(run.message) : undefined,
      };
    }),

    health("cron-last-http", "Last pg_net call to /api/chain/jobs", async () => {
      const http = (await deps.snapshot()).cron.last_http;
      if (!http) return { status: "unknown", value: "—", detail: "No pg_net response log in this database" };
      const age = ageSeconds(http.created, deps.now());
      const when = age === null ? "" : `${formatAge(age)} ago`;
      if (http.timed_out) return { status: "crit", value: "Timed out", detail: when };
      const code = http.status_code;
      if (code === 200) {
        // pg_net keeps old responses for a while: a 200 long ago means calls stopped.
        const stale = age === null ? "unknown" : highIsBad(age, CRON_RUN_AGE_SECONDS);
        return {
          status: stale,
          value: "HTTP 200",
          threshold: `crit when the last call is ≥ ${CRON_RUN_AGE_SECONDS.crit / 60} min old`,
          detail: when,
        };
      }
      if (code === 401) {
        return {
          status: "crit",
          value: "HTTP 401",
          detail: `${when} · the app refused the bearer: CRON_SECRET is unset in the app or differs from Vault's doqtri_cron_secret`,
        };
      }
      if (code === null) return { status: "crit", value: "No response", detail: redactMessage(http.error) ?? when };
      return { status: code >= 500 ? "crit" : "warn", value: `HTTP ${code}`, detail: when };
    }),
  ];
}

function dependencyChecks(deps: OpsDeps): OpsCheckDef[] {
  const { config } = deps;
  return [
    health("soroban-rpc", "Soroban RPC", async () => {
      const started = deps.now();
      const answer = await deps.rpcHealth();
      const ms = deps.now() - started;
      const source = config.dedicatedRpc ? "dedicated SOROBAN_RPC_URL" : "public default";
      if (answer.status !== "healthy") return { status: "crit", value: answer.status, detail: source };
      return {
        status: ms > PROBE_SLOW_MS ? "warn" : "ok",
        value: `${ms} ms`,
        threshold: `healthy · warn > ${PROBE_SLOW_MS / 1000} s`,
        detail: `ledger ${answer.latestLedger.toLocaleString("en-US")} · ${source}`,
      };
    }),

    health("horizon", "Horizon", async () => {
      const res = await deps.fetch(config.horizonUrl);
      if (!res.ok) return { status: "crit", value: `HTTP ${res.status}` };
      const root = (await res.json()) as { history_latest_ledger?: number; history_latest_ledger_closed_at?: string };
      const age = ageSeconds(root.history_latest_ledger_closed_at, deps.now());
      if (age === null) return { status: "unknown", value: "—", detail: "No ledger close time in Horizon's answer" };
      return {
        status: highIsBad(age, LEDGER_AGE_SECONDS),
        value: `ledger ${formatAge(age)} old`,
        threshold: `warn ≥ ${LEDGER_AGE_SECONDS.warn} s · crit ≥ ${LEDGER_AGE_SECONDS.crit} s`,
        detail: root.history_latest_ledger ? `ledger ${root.history_latest_ledger.toLocaleString("en-US")}` : undefined,
      };
    }),

    health("friendbot", "Friendbot", async () => {
      if (config.network !== "testnet") return { status: "off", value: "—", detail: "Testnet only" };
      // No address: Friendbot answers 400 at once and funds nothing.
      return upOrDown(await reachable(deps, "https://friendbot.stellar.org/"));
    }),

    health("openai", "OpenAI API", async () => {
      const key = process.env.OPENAI_API_KEY?.trim();
      if (!key) return { status: "off", value: "—", detail: "OPENAI_API_KEY is unset" };
      // Listing models is free.
      const probe = await reachable(deps, "https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      if (probe.status === 401) return { status: "crit", value: "Key rejected", detail: "OpenAI refused OPENAI_API_KEY: AI features fail" };
      if (probe.status === 429) return { status: "warn", value: "Rate limited", detail: "Check the account's usage and billing" };
      if (probe.status >= 400 && probe.status < 500) return { status: "crit", value: `HTTP ${probe.status}` };
      return upOrDown(probe);
    }),

    health("qdit-api", "qdit API and OAuth", async () => {
      if (!qditIntegrationEnabled()) return { status: "off", value: "—", detail: "NEXT_PUBLIC_QDIT_INTEGRATION is off" };
      const qdit = qditConfig();
      if (!qdit) return { status: "crit", value: "Not configured", detail: "See the qdit settings check" };
      // Without a token both answer 401: reachable is all this asks.
      const [api, auth] = await Promise.all([
        reachable(deps, `${qdit.apiBaseUrl}/me`),
        reachable(deps, `${qdit.issuer}/health`),
      ]);
      // A 404 means the configured base or issuer path is wrong, not that qdit is up.
      const judged = (probe: { status: number; ms: number }): OpsResult =>
        probe.status === 404 ? { status: "warn", value: "HTTP 404" } : upOrDown(probe);
      const a = judged(api);
      const b = judged(auth);
      return {
        status: worst([a.status, b.status]),
        value: `API ${a.value} · OAuth ${b.value}`,
        threshold: `warn > ${PROBE_SLOW_MS / 1000} s`,
      };
    }),

    health("stellar-expert", "stellar.expert", async () =>
      // Only the public stats read it, so down is a warning.
      upOrDown(await reachable(deps, config.expertApiUrl), "warn"),
    ),
  ];
}

function configChecks(deps: OpsDeps): OpsCheckDef[] {
  const { config } = deps;
  return [
    health("config-cron-secret", "CRON_SECRET", async () =>
      present("CRON_SECRET")
        ? { status: "ok", value: "Set" }
        : {
            status: "crit",
            value: "Unset",
            detail: "GET /api/chain/jobs refuses every call: neither pg_cron nor the daily Vercel cron can run the queues",
          },
    ),

    health("config-relayer-key", "Relayer key", async () => {
      const secret = process.env.DOQTRI_RELAYER_SECRET?.trim();
      if (!config.relayer) return { status: "off", value: "—", detail: "No relayer on this network" };
      if (!secret) return { status: "crit", value: "Unset", detail: "DOQTRI_RELAYER_SECRET is unset: paid writes answer 503" };
      let publicKey: string;
      try {
        publicKey = Keypair.fromSecret(secret).publicKey();
      } catch {
        return { status: "crit", value: "Malformed", detail: "DOQTRI_RELAYER_SECRET is not a Stellar secret key" };
      }
      return publicKey === config.relayer
        ? { status: "ok", value: "Matches", detail: shortKey(config.relayer) }
        : {
            status: "crit",
            value: "Mismatch",
            detail: `the key is ${shortKey(publicKey)} but the app names ${shortKey(config.relayer)}: set NEXT_PUBLIC_DOQTRI_RELAYER`,
          };
    }),

    health("config-channels-key", "CHANNELS_API_KEY", async () =>
      present("CHANNELS_API_KEY")
        ? { status: "ok", value: "Set", detail: "daily fee cap not readable: FEE_LIMIT_EXCEEDED in the logs is the signal" }
        : { status: "crit", value: "Unset", detail: "the sponsored relay answers 503" },
    ),

    health("config-contract-id", "NEXT_PUBLIC_CONTRACT_ID", async () => {
      const raw = process.env.NEXT_PUBLIC_CONTRACT_ID?.trim().replace(/^["']|["']$/g, "") ?? "";
      if (raw && LEGACY_CONTRACT_IDS.includes(raw)) {
        return {
          status: "warn",
          value: "Legacy registry",
          detail: `${shortKey(raw)} is ignored; the app uses ${shortKey(config.registry)}. Set it to that or remove it`,
        };
      }
      return { status: "ok", value: raw ? "Set" : "Default", detail: shortKey(config.registry) };
    }),

    health("config-qdit", "qdit settings", async () => {
      if (!qditIntegrationEnabled()) return { status: "off", value: "—", detail: "NEXT_PUBLIC_QDIT_INTEGRATION is off" };
      if (!qditConfig()) {
        return {
          status: "crit",
          value: "Incomplete",
          detail: "needs QDIT_API_BASE_URL, QDIT_OAUTH_ISSUER, QDIT_OAUTH_CLIENT_ID, QDIT_CLIENT_SECRET and INTEGRATION_TOKEN_KEY",
        };
      }
      if (!qditWebhookSecret()) return { status: "crit", value: "No webhook secret", detail: "QDIT_WEBHOOK_SECRET is unset: the webhook answers 503" };
      return { status: "ok", value: "Complete" };
    }),

    health("config-relay-pool", "Relay pool settings", async () => {
      if (!relayPoolEnabled()) return { status: "off", value: "Off", detail: "RELAY_POOL is not on" };
      const seed = process.env.RELAY_CHANNEL_SEED?.trim() ?? "";
      if (seed.length < MIN_SEED_LENGTH) {
        return { status: "crit", value: seed ? "Seed too short" : "No seed", detail: `RELAY_CHANNEL_SEED needs ${MIN_SEED_LENGTH}+ characters: paid writes answer 503` };
      }
      return { status: "ok", value: "On" };
    }),
  ];
}

export function healthChecks(deps: OpsDeps): OpsCheckDef[] {
  return [...schedulerChecks(deps), ...dependencyChecks(deps), ...configChecks(deps)];
}
