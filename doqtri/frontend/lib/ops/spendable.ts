import { aiDailyLimit } from "@/lib/ai-quota";
import {
  formatBytes,
  formatCount,
  formatXlm,
  highIsBad,
  lowIsBad,
  percent,
  shortKey,
  type Limits,
} from "@/lib/ops/levels";
import type { OpsDeps } from "@/lib/ops/deps";
import type { OpsCheckDef, OpsResult } from "@/lib/ops/types";
import { CHAIN_QUOTA_CAPS, type ChainQuotaKind } from "@/lib/stellar/chain-quota-caps";
import { TESTNET_REFILL_BELOW_XLM } from "@/lib/stellar/channel-accounts.mjs";
import { relayPoolEnabled } from "@/lib/stellar/channel-pool";
import { serverKeypair } from "@/lib/stellar/server-signer";

/**
 * Relayer and channel accounts pay every paid write's fee. On testnet the
 * relayer refills itself from Friendbot below 1,000 XLM (direct-submit.ts),
 * and the seed script refills channels below the same floor, so crit is that
 * floor and warn is twice it. Mainnet writes cost well under 1 XLM each.
 */
export const FEE_PAYER_LIMITS: Readonly<Record<"testnet" | "mainnet", Limits>> = {
  testnet: { warn: 2 * TESTNET_REFILL_BELOW_XLM, crit: TESTNET_REFILL_BELOW_XLM },
  mainnet: { warn: 50, crit: 10 },
};

/** The revoker and the contract admin sign a few calls a day. */
export const SIGNER_LIMITS: Limits = { warn: 50, crit: 10 };

/** Share of a daily cap used, in percent. */
export const QUOTA_LIMITS: Limits = { warn: 70, crit: 90 };

/** GitHub API calls left, in percent of the hourly limit. */
export const GITHUB_LIMITS: Limits = { warn: 20, crit: 5 };

/** Days until a contract's instance or code entry is archived. */
export const TTL_DAYS_LIMITS: Limits = { warn: 30, crit: 7 };

/** Supabase Pro includes 8 GB of database and 100 GB of file storage. */
export const SUPABASE_PRO = { dbBytes: 8 * 1024 ** 3, storageBytes: 100 * 1024 ** 3 };

/** Share of the plan's included size, in percent. */
export const SIZE_LIMITS: Limits = { warn: 70, crit: 90 };

/** Average ledger close time. */
const SECONDS_PER_LEDGER = 5;

function limitsText({ warn, crit }: Limits, unit: string, below = true): string {
  const sign = below ? "<" : "≥";
  return `warn ${sign} ${formatCount(warn)}${unit} · crit ${sign} ${formatCount(crit)}${unit}`;
}

async function feePayer(deps: OpsDeps, address: string | null, limits: Limits, missing: string): Promise<OpsResult> {
  if (!address) return { status: "off", value: "—", detail: missing };
  const account = await deps.balance(address);
  if (!account.funded) {
    return { status: "crit", value: "No account", detail: `${shortKey(address)} does not exist on ${deps.config.network}` };
  }
  return {
    status: lowIsBad(account.spendable, limits),
    value: formatXlm(account.spendable),
    threshold: limitsText(limits, " XLM"),
    detail: shortKey(address),
  };
}

function relayer(deps: OpsDeps): OpsCheckDef {
  return {
    id: "relayer-balance",
    section: "spendable",
    label: "Relayer XLM",
    run: async () => {
      const result = await feePayer(deps, deps.config.relayer, FEE_PAYER_LIMITS[deps.config.network], "No relayer on this network");
      if (deps.config.network === "testnet" && result.detail) {
        result.detail = `${result.detail} · refills from Friendbot below ${formatCount(TESTNET_REFILL_BELOW_XLM)} XLM`;
      }
      return result;
    },
  };
}

function channels(deps: OpsDeps): OpsCheckDef {
  return {
    id: "channel-balances",
    section: "spendable",
    label: "Relay channel XLM",
    run: async () => {
      const keys = await deps.channelKeys();
      const poolOn = relayPoolEnabled();
      if (keys.length === 0) {
        return poolOn
          ? { status: "crit", value: "0 channels", detail: "RELAY_POOL is on but relay_channels is empty: run the seed script" }
          : { status: "off", value: "—", detail: "RELAY_POOL is off and no channels are seeded" };
      }
      const limits = FEE_PAYER_LIMITS[deps.config.network];
      const accounts = await Promise.all(keys.map((key) => deps.balance(key)));
      const balances = accounts.map((a) => (a.funded ? a.spendable : 0));
      const low = balances.filter((b) => b < limits.crit).length;
      const min = Math.min(...balances);
      const status = lowIsBad(min, limits);
      return {
        // Channels only pay while the pool is on; a low one with it off can wait.
        status: poolOn ? status : status === "ok" ? "ok" : "warn",
        value: `min ${formatXlm(min)}`,
        threshold: limitsText(limits, " XLM"),
        detail: `${keys.length} channels, ${low} below ${formatCount(limits.crit)} XLM · RELAY_POOL ${poolOn ? "on" : "off"} · refilled only by the seed script`,
      };
    },
  };
}

function signer(deps: OpsDeps, id: string, label: string, name: "REVOKER_SECRET_KEY" | "CONTRACT_ADMIN_SECRET"): OpsCheckDef {
  return {
    id,
    section: "spendable",
    label,
    run: async () => {
      const kp = serverKeypair(name);
      if (!kp) {
        // Revokes stall without the revoker once registry editors are on.
        if (name === "REVOKER_SECRET_KEY" && deps.config.registryEditors) {
          return { status: "crit", value: "Unset", detail: "REGISTRY_EDITORS is on but REVOKER_SECRET_KEY is unset: removals never reach the chain" };
        }
        return { status: "off", value: "—", detail: `${name} is unset` };
      }
      return feePayer(deps, kp.publicKey(), SIGNER_LIMITS, `${name} is unset`);
    },
  };
}

const QUOTA_LABELS: Record<ChainQuotaKind, string> = {
  deploy: "Wallet deploys, 24 h",
  write: "Chain writes, 24 h",
  market: "Market calls, 24 h",
  publish: "Template publishes, 24 h",
};

function quota(deps: OpsDeps, kind: ChainQuotaKind): OpsCheckDef {
  return {
    id: `quota-${kind}`,
    section: "spendable",
    label: QUOTA_LABELS[kind],
    run: async () => {
      const snapshot = await deps.snapshot();
      const used =
        snapshot.chain_usage_24h.find((row) => row.network === deps.config.network && row.kind === kind)?.count ?? 0;
      const cap = CHAIN_QUOTA_CAPS[kind];
      const share = percent(used, cap.global);
      return {
        status: highIsBad(share, QUOTA_LIMITS),
        value: `${formatCount(used)} / ${formatCount(cap.global)}`,
        threshold: `global cap · warn ≥ ${QUOTA_LIMITS.warn}% · crit ≥ ${QUOTA_LIMITS.crit}%`,
        detail: `${Math.round(share)}% used · ${formatCount(cap.perUser)} per user`,
      };
    },
  };
}

function ai(deps: OpsDeps): OpsCheckDef {
  return {
    id: "ai-usage",
    section: "spendable",
    label: "AI calls, 24 h",
    run: async () => {
      if (!process.env.OPENAI_API_KEY?.trim()) return { status: "off", value: "—", detail: "OPENAI_API_KEY is unset" };
      const { ai_usage_24h: usage } = await deps.snapshot();
      const limit = aiDailyLimit();
      const routes = Object.entries(usage.by_route)
        .sort((a, b) => b[1] - a[1])
        .map(([route, n]) => `${route} ${formatCount(n)}`)
        .join(" · ");
      return {
        status: usage.top_user >= limit ? "warn" : "ok",
        value: `${formatCount(usage.total)} calls`,
        threshold: `${formatCount(limit)} per user per 24 h · no global cap`,
        detail: `${routes || "no calls"} · heaviest user ${formatCount(usage.top_user)}${usage.top_user >= limit ? " (at the limit)" : ""}`,
      };
    },
  };
}

function github(deps: OpsDeps): OpsCheckDef {
  return {
    id: "github-rate-limit",
    section: "spendable",
    label: "GitHub API calls left",
    run: async () => {
      const token = process.env.GITHUB_TOKEN?.trim();
      if (!token) return { status: "off", value: "—", detail: "GITHUB_TOKEN is unset" };
      // GET /rate_limit does not count against the limit.
      const res = await deps.fetch("https://api.github.com/rate_limit", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (res.status === 401) return { status: "crit", value: "Rejected", detail: "GitHub refused GITHUB_TOKEN" };
      if (!res.ok) return { status: "unknown", value: "—", detail: `GitHub answered HTTP ${res.status}` };
      const body = (await res.json()) as { resources?: { core?: { limit?: number; remaining?: number; reset?: number } } };
      const core = body.resources?.core;
      if (typeof core?.limit !== "number" || typeof core.remaining !== "number") {
        return { status: "unknown", value: "—", detail: "GitHub's answer had no core limit" };
      }
      const share = percent(core.remaining, core.limit);
      const reset = typeof core.reset === "number" ? ` · resets ${new Date(core.reset * 1000).toISOString().slice(11, 16)} UTC` : "";
      return {
        status: lowIsBad(share, GITHUB_LIMITS),
        value: `${formatCount(core.remaining)} / ${formatCount(core.limit)}`,
        threshold: `warn < ${GITHUB_LIMITS.warn}% · crit < ${GITHUB_LIMITS.crit}%`,
        detail: `per hour${reset}`,
      };
    },
  };
}

function ttl(deps: OpsDeps, id: string, label: string, contractId: string | null, note?: string): OpsCheckDef {
  return {
    id,
    section: "spendable",
    label,
    run: async () => {
      if (!contractId) return { status: "off", value: "—", detail: `Not deployed on ${deps.config.network}` };
      const entry = await deps.contractTtl(contractId);
      if (!entry) return { status: "crit", value: "Not found", detail: `${shortKey(contractId)} has no instance on ${deps.config.network}` };
      const until = [entry.instanceLiveUntil, entry.codeLiveUntil].filter((n): n is number => n !== null);
      if (until.length === 0) return { status: "unknown", value: "—", detail: "The RPC returned no live-until ledger" };
      const ledgers = Math.min(...until) - entry.latestLedger;
      const days = (ledgers * SECONDS_PER_LEDGER) / 86400;
      const which = entry.codeLiveUntil !== null && entry.codeLiveUntil < (entry.instanceLiveUntil ?? Infinity) ? "code" : "instance";
      return {
        status: lowIsBad(days, TTL_DAYS_LIMITS),
        value: `${Math.max(0, Math.floor(days))} days`,
        threshold: limitsText(TTL_DAYS_LIMITS, " days"),
        detail: `${shortKey(contractId)} · ${which} entry expires first${note ? ` · ${note}` : ""}`,
      };
    },
  };
}

function database(deps: OpsDeps): OpsCheckDef {
  return {
    id: "db-size",
    section: "spendable",
    label: "Database size",
    run: async () => {
      const { storage } = await deps.snapshot();
      const share = percent(storage.db_bytes, SUPABASE_PRO.dbBytes);
      return {
        status: highIsBad(share, SIZE_LIMITS),
        value: formatBytes(storage.db_bytes),
        threshold: `of ${formatBytes(SUPABASE_PRO.dbBytes)} on Pro · warn ≥ ${SIZE_LIMITS.warn}% · crit ≥ ${SIZE_LIMITS.crit}%`,
        detail: `${share.toFixed(1)}% of the included size`,
      };
    },
  };
}

function fileStorage(deps: OpsDeps): OpsCheckDef {
  return {
    id: "storage-size",
    section: "spendable",
    label: "File storage",
    run: async () => {
      const { storage } = await deps.snapshot();
      if (!storage.buckets) return { status: "unknown", value: "—", detail: "This database records no object sizes" };
      const total = Object.values(storage.buckets).reduce((a, b) => a + b, 0);
      const share = percent(total, SUPABASE_PRO.storageBytes);
      const buckets = Object.entries(storage.buckets)
        .map(([bucket, bytes]) => `${bucket} ${formatBytes(bytes)}`)
        .join(" · ");
      return {
        status: highIsBad(share, SIZE_LIMITS),
        value: formatBytes(total),
        threshold: `of ${formatBytes(SUPABASE_PRO.storageBytes)} on Pro · warn ≥ ${SIZE_LIMITS.warn}% · crit ≥ ${SIZE_LIMITS.crit}%`,
        detail: buckets || "no files",
      };
    },
  };
}

export function spendableChecks(deps: OpsDeps): OpsCheckDef[] {
  return [
    relayer(deps),
    channels(deps),
    signer(deps, "revoker-balance", "Revoker XLM", "REVOKER_SECRET_KEY"),
    signer(deps, "contract-admin-balance", "Contract admin XLM", "CONTRACT_ADMIN_SECRET"),
    quota(deps, "deploy"),
    quota(deps, "write"),
    quota(deps, "market"),
    quota(deps, "publish"),
    ai(deps),
    github(deps),
    ttl(deps, "ttl-registry", "Registry contract TTL", deps.config.registry, "extended on touch"),
    ttl(deps, "ttl-market", "Market contract TTL", deps.config.market, "extended on touch"),
    ttl(deps, "ttl-fee-forwarder", "Fee forwarder TTL", deps.config.feeForwarder, "no extend logic: extend by hand"),
    database(deps),
    fileStorage(deps),
  ];
}
