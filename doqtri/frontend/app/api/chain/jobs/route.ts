import { timingSafeEqual } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { runChainJobs } from "@/lib/stellar/chain-jobs";
import { readSchedulerHealth, schedulerWarning } from "@/lib/stellar/chain-jobs-scheduler";

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
 */
export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Not allowed." }, { status: 401 });
  const admin = createSupabaseAdminClient();
  const scheduler = await readSchedulerHealth(admin);
  const warning = schedulerWarning(scheduler);
  if (warning) console.warn(`[chain/jobs] ${warning}`);
  try {
    return Response.json({ ...(await runChainJobs(admin, { limit: 50 })), scheduler });
  } catch (error) {
    console.error("[chain/jobs] failed", error);
    return Response.json({ error: "The queue couldn't run.", scheduler }, { status: 503 });
  }
}
