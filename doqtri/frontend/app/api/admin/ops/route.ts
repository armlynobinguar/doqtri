import { isAdmin } from "@/lib/admin";
import { collectOps } from "@/lib/ops/collect";
import { liveOpsDeps } from "@/lib/ops/deps";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ops dashboard's report (DOQ-14, WP-4.3), for doqtri staff
 * (DOQTRI_ADMINS): what can run out, what is queued, and whether the
 * scheduled runs and dependencies work. /admin/ops polls it every minute.
 * Each check has 5 s; one that fails or times out reads as unknown and the
 * rest still answer. Public keys, counts and presence only: no secret, keyed
 * URL or user data.
 *
 * 404 for anyone else, as the other admin routes answer.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdmin(user)) return Response.json({ error: "Not found" }, { status: 404 });

  const report = await collectOps(liveOpsDeps(createSupabaseAdminClient()));
  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}
