import { timingSafeEqual } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { runChainJobs } from "@/lib/stellar/chain-jobs";

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
 * when nobody opens the members screen (D-16). Called by a scheduler with
 * `Authorization: Bearer $CRON_SECRET`; refused without it.
 */
export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Not allowed." }, { status: 401 });
  try {
    return Response.json(await runChainJobs(createSupabaseAdminClient(), { limit: 50 }));
  } catch (error) {
    console.error("[chain/jobs] failed", error);
    return Response.json({ error: "The queue couldn't run." }, { status: 503 });
  }
}
