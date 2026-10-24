import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Whether the database's pg_cron job can work the on-chain follow-up queue
 * every minute: `chain_jobs_scheduler_health()` of
 * backend/migrations/20261025090000_chain_jobs_scheduler.sql, called with
 * the service role.
 *
 *   configured    the job is active and Vault holds both its secrets;
 *   missing       the job is inactive or unscheduled, or a secret is
 *                 missing (named);
 *   unavailable   this database has no pg_cron, pg_net or Vault;
 *   unknown       the check itself failed (logged), so nothing is claimed.
 *
 * Anything but `configured` means a removal whose first send failed is
 * retried only by the daily Vercel cron and when someone opens the members
 * screen. GET /api/chain/jobs returns this with every run and logs it, and
 * GET /api/admin/chain-jobs shows it to doqtri staff.
 */

export type ChainJobsSchedulerHealth = {
  status: "configured" | "missing" | "unavailable" | "unknown";
  job: boolean | null;
  missingSecrets: string[];
};

const UNKNOWN: ChainJobsSchedulerHealth = { status: "unknown", job: null, missingSecrets: [] };

const STATUSES = new Set(["configured", "missing", "unavailable"]);

/** The function's jsonb, checked; anything unexpected reads as `unknown`. */
export function parseSchedulerHealth(value: unknown): ChainJobsSchedulerHealth {
  if (typeof value !== "object" || value === null) return UNKNOWN;
  const { status, job, missing_secrets: missing } = value as Record<string, unknown>;
  if (typeof status !== "string" || !STATUSES.has(status)) return UNKNOWN;
  if (typeof job !== "boolean") return UNKNOWN;
  if (!Array.isArray(missing) || !missing.every((name) => typeof name === "string")) return UNKNOWN;
  return { status: status as ChainJobsSchedulerHealth["status"], job, missingSecrets: missing };
}

const FALLBACK = "only the daily Vercel cron and the members screen retry pending on-chain removals";

/** One line for the log, or null when there is nothing to warn about. */
export function schedulerWarning(health: ChainJobsSchedulerHealth): string | null {
  switch (health.status) {
    case "configured":
      return null;
    case "missing":
      return health.missingSecrets.length > 0
        ? `chain jobs: the pg_cron job doqtri-chain-jobs sends nothing until Vault holds ${health.missingSecrets.join(", ")}; ${FALLBACK}. See doqtri/docs/runbooks/registry-editors-rollout.md.`
        : `chain jobs: the pg_cron job doqtri-chain-jobs is missing or inactive; ${FALLBACK}.`;
    case "unavailable":
      return `chain jobs: this database has no pg_cron, pg_net or Vault; ${FALLBACK}.`;
    case "unknown":
      return "chain jobs: could not read the pg_cron job's health.";
  }
}

/** Never throws: a failed check is `unknown`, and the queue runs on. */
export async function readSchedulerHealth(admin: SupabaseClient): Promise<ChainJobsSchedulerHealth> {
  try {
    const { data, error } = await admin.rpc("chain_jobs_scheduler_health");
    if (error) {
      console.error("[chain/jobs] scheduler health check failed:", error.message);
      return UNKNOWN;
    }
    return parseSchedulerHealth(data);
  } catch (error) {
    console.error("[chain/jobs] scheduler health check failed:", error instanceof Error ? error.message : error);
    return UNKNOWN;
  }
}
