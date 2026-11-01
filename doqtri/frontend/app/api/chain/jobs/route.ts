import { timingSafeEqual } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { runChainJobs } from "@/lib/stellar/chain-jobs";
import { readSchedulerHealth, schedulerWarning } from "@/lib/stellar/chain-jobs-scheduler";
import { runPendingWrites } from "@/lib/stellar/pending-writes";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The scheduled run of the on-chain follow-up queue (chain-jobs.ts), so a
 * removal whose send failed is retried until the ledger confirms it even
 * when nobody opens the members screen (D-16). Called every minute by the
 * database's pg_cron job, and once a day by the Vercel cron in vercel.json
 * as a backstop (backend/migrations/20261025090000_chain_jobs_scheduler.sql),
 * with `Authorization: Bearer $CRON_SECRET`; refused without it.
 *
 * Every response carries `scheduler`, whether the pg_cron job can run
 * (chain-jobs-scheduler.ts), and a run logs a warning when it cannot, so
 * the daily backstop's log says when it is all there is.
 *
 * Each run also settles paid writes the relay answered 202 for
 * (pending-writes.ts, DOQ-5), reported as `pendingWrites`, or null when the
 * ledger or the database couldn't be read; the queue runs either way.
 */
export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Not allowed." }, { status: 401 });
  const admin = createSupabaseAdminClient();
  const scheduler = await readSchedulerHealth(admin);
  const warning = schedulerWarning(scheduler);
  if (warning) console.warn(`[chain/jobs] ${warning}`);
  const pendingWrites = await runPendingWrites(admin).catch((error: Error) => {
    console.error(`[chain/jobs] pending writes not settled: ${error.message}`);
    return null;
  });
  try {
    return Response.json({ ...(await runChainJobs(admin, { limit: 50 })), pendingWrites, scheduler });
  } catch (error) {
    console.error("[chain/jobs] failed", error);
    return Response.json({ error: "The queue couldn't run.", pendingWrites, scheduler }, { status: 503 });
  }
}
