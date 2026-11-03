import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { ageSeconds, formatAge, formatCount, highIsBad, percent, worst, type Limits } from "@/lib/ops/levels";
import type { OpsDeps, OpsSnapshot } from "@/lib/ops/deps";
import type { OpsCheckDef, OpsResult } from "@/lib/ops/types";
import { relayPoolEnabled } from "@/lib/stellar/channel-pool";

/**
 * Queue limits. pg_cron runs the chain jobs every minute, so anything pending
 * past a few runs is stuck. A paid write's time bound is 60 s and the same
 * run settles it. These are starting points; tune them from what the page
 * shows over the first weeks.
 */
export const CHAIN_JOB_AGE_MINUTES: Limits = { warn: 10, crit: 60 };
export const TOPUP_AGE_MINUTES: Limits = { warn: 30, crit: 120 };
export const PENDING_WRITE_AGE_SECONDS: Limits = { warn: 120, crit: 600 };
export const FAILED_WRITES_24H: Limits = { warn: 5, crit: 25 };
/** Share of channels leased at the moment of the read, in percent. */
export const LEASED_SHARE: Limits = { warn: 80, crit: 100 };
/** Share of ingests that failed over 24 h, counted once there are at least 5. */
export const INGEST_FAILURE_SHARE: Limits = { warn: 20, crit: 50 };
export const MIN_INGESTS_FOR_RATE = 5;
/** Share of qdit connections waiting for their user to reconnect. */
export const RECONNECT_SHARE: Limits = { warn: 20, crit: 50 };
export const LATE_WEBHOOKS: Limits = { warn: 1, crit: 10 };

function minutesLimits({ warn, crit }: Limits): string {
  return `oldest pending: warn ≥ ${warn} min · crit ≥ ${crit} min`;
}

/** The oldest pending item's age, judged in minutes. */
function backlog(pending: number, oldest: string | null, nowMs: number, limits: Limits): { status: OpsResult["status"]; text: string } {
  if (pending === 0) return { status: "ok", text: "none pending" };
  const age = ageSeconds(oldest, nowMs) ?? 0;
  return { status: highIsBad(age / 60, limits), text: `oldest ${formatAge(age)}` };
}

function fromSnapshot(
  deps: OpsDeps,
  id: string,
  label: string,
  read: (snapshot: OpsSnapshot) => OpsResult,
): OpsCheckDef {
  return { id, section: "statuses", label, run: async () => read(await deps.snapshot()) };
}

export function statusChecks(deps: OpsDeps): OpsCheckDef[] {
  const now = deps.now;
  const testnet = deps.config.network === "testnet";

  return [
    fromSnapshot(deps, "chain-jobs-backlog", "Chain jobs pending", ({ chain_jobs: jobs }) => {
      const b = backlog(jobs.pending, jobs.oldest_pending_at, now(), CHAIN_JOB_AGE_MINUTES);
      return {
        status: b.status,
        value: `${formatCount(jobs.pending)} pending`,
        threshold: minutesLimits(CHAIN_JOB_AGE_MINUTES),
        detail: `${b.text} · on-chain revokes and owner handovers`,
      };
    }),

    fromSnapshot(deps, "chain-jobs-attention", "Chain jobs needing a person", ({ chain_jobs: jobs }) => ({
      status: jobs.needs_product_owner > 0 || jobs.failed_24h > 0 ? "warn" : "ok",
      value: `${formatCount(jobs.needs_product_owner)} need owner · ${formatCount(jobs.failed_24h)} failed`,
      threshold: "warn ≥ 1 needing the product owner, or failed in 24 h",
      detail: `${formatCount(jobs.failed)} failed in total · needs_product_owner waits for CONTRACT_ADMIN_SECRET`,
    })),

    fromSnapshot(deps, "wallet-topups", "Wallet top-up retries", ({ wallet_topups: topups }) => {
      if (!testnet) return { status: "off", value: "—", detail: "Friendbot top-ups are testnet only" };
      const b = backlog(topups.pending, topups.oldest_pending_at, now(), TOPUP_AGE_MINUTES);
      return {
        status: worst([b.status, topups.failed_24h > 0 ? "warn" : "ok"]),
        value: `${formatCount(topups.pending)} pending · ${formatCount(topups.failed_24h)} gave up`,
        threshold: `${minutesLimits(TOPUP_AGE_MINUTES)} · warn ≥ 1 gave up in 24 h`,
        detail: `${b.text} · ${formatCount(topups.failed)} gave up in total`,
      };
    }),

    fromSnapshot(deps, "pending-writes", "Paid writes pending", ({ chain_writes: writes }) => {
      const age = writes.pending > 0 ? (ageSeconds(writes.oldest_pending_at, now()) ?? 0) : 0;
      return {
        status: worst([highIsBad(age, PENDING_WRITE_AGE_SECONDS), highIsBad(writes.failed_24h, FAILED_WRITES_24H)]),
        value: `${formatCount(writes.pending)} pending · ${formatCount(writes.failed_24h)} failed 24 h`,
        threshold: `oldest pending: warn ≥ ${PENDING_WRITE_AGE_SECONDS.warn} s · crit ≥ ${PENDING_WRITE_AGE_SECONDS.crit} s · failed: warn ≥ ${FAILED_WRITES_24H.warn} · crit ≥ ${FAILED_WRITES_24H.crit}`,
        detail: writes.pending > 0 ? `oldest ${formatAge(age)}` : "none pending",
      };
    }),

    fromSnapshot(deps, "channel-leases", "Relay channels leased", ({ relay_channels: rows }) => {
      const row = rows.find((r) => r.network === deps.config.network);
      const poolOn = relayPoolEnabled();
      if (!row || row.total === 0) {
        return poolOn
          ? { status: "crit", value: "0 channels", detail: "RELAY_POOL is on but relay_channels is empty" }
          : { status: "off", value: "—", detail: "RELAY_POOL is off" };
      }
      const share = percent(row.leased, row.total);
      return {
        status: poolOn ? highIsBad(share, LEASED_SHARE) : "off",
        value: `${formatCount(row.leased)} / ${formatCount(row.total)}`,
        threshold: `warn ≥ ${LEASED_SHARE.warn}% · crit at ${LEASED_SHARE.crit}% (writes wait, then 503)`,
        detail: `RELAY_POOL ${poolOn ? "on" : "off"} · a 30-write burst needs about 40`,
      };
    }),

    fromSnapshot(deps, "ingests", "Document imports, 24 h", ({ ingests }) => {
      const share = percent(ingests.failed_24h, ingests.total_24h);
      const rate = ingests.total_24h >= MIN_INGESTS_FOR_RATE ? highIsBad(share, INGEST_FAILURE_SHARE) : "ok";
      return {
        status: worst([rate, ingests.stuck_pending > 0 ? "warn" : "ok"]),
        value: `${formatCount(ingests.failed_24h)} / ${formatCount(ingests.total_24h)} failed`,
        threshold: `failed share: warn ≥ ${INGEST_FAILURE_SHARE.warn}% · crit ≥ ${INGEST_FAILURE_SHARE.crit}% (from ${MIN_INGESTS_FOR_RATE} imports) · warn on any stuck`,
        detail: `${formatCount(ingests.stuck_pending)} pending past 280 s`,
      };
    }),

    fromSnapshot(deps, "qdit-connections", "qdit connections", ({ qdit }) => {
      if (!qditIntegrationEnabled()) return { status: "off", value: "—", detail: "NEXT_PUBLIC_QDIT_INTEGRATION is off" };
      const counts = qdit.connections;
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const reconnect = counts.needs_reconnect ?? 0;
      const share = percent(reconnect, total - (counts.revoked ?? 0));
      return {
        status: highIsBad(share, RECONNECT_SHARE),
        value: `${formatCount(counts.connected ?? 0)} connected`,
        threshold: `needs reconnect: warn ≥ ${RECONNECT_SHARE.warn}% · crit ≥ ${RECONNECT_SHARE.crit}%`,
        detail: `${formatCount(reconnect)} need reconnect · ${formatCount(counts.revoked ?? 0)} revoked`,
      };
    }),

    fromSnapshot(deps, "qdit-webhooks", "qdit webhooks late", ({ qdit }) => {
      if (!qditIntegrationEnabled()) return { status: "off", value: "—", detail: "NEXT_PUBLIC_QDIT_INTEGRATION is off" };
      return {
        status: highIsBad(qdit.webhooks_late, LATE_WEBHOOKS),
        value: `${formatCount(qdit.webhooks_late)} late`,
        threshold: `unprocessed after 5 min: warn ≥ ${LATE_WEBHOOKS.warn} · crit ≥ ${LATE_WEBHOOKS.crit}`,
      };
    }),

    fromSnapshot(deps, "template-reports", "Template reports open", ({ moderation }) => ({
      status: moderation.reports_open > 0 ? "warn" : "ok",
      value: `${formatCount(moderation.reports_open)} open`,
      threshold: "warn ≥ 1",
      detail: `review at /admin/reports · ${formatCount(moderation.templates_pending)} templates awaiting on-chain confirmation`,
    })),

    fromSnapshot(deps, "promo-queue", "Promo entries", ({ moderation }) => ({
      status: moderation.promo_rating_errors > 0 ? "warn" : "ok",
      value: `${formatCount(moderation.promo_pending)} to review`,
      threshold: "warn on any AI rating error",
      detail: `${formatCount(moderation.promo_rating_errors)} AI rating errors · review at /admin/promo`,
    })),

    fromSnapshot(deps, "doc-locks", "Edit locks", ({ doc_locks: locks }) => ({
      status: "ok",
      value: `${formatCount(locks.active)} active`,
      detail: `${formatCount(locks.stale)} expired (free to take; harmless)`,
    })),
  ];
}
