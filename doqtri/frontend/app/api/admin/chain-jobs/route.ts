import { isAdmin } from "@/lib/admin";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { REGISTRY_EDITORS } from "@/lib/stellar/config";
import { readSchedulerHealth, schedulerWarning } from "@/lib/stellar/chain-jobs-scheduler";

export const runtime = "nodejs";

const OPEN_STATUSES = ["pending", "needs_product_owner", "failed"] as const;

/**
 * The on-chain follow-up queue's health, for doqtri staff (DOQTRI_ADMINS):
 * whether the database's pg_cron job can run it every minute (`scheduler`,
 * with `warning` when it cannot), how many jobs are open by status, and
 * when the oldest pending one was queued. A pending job much older than a
 * few minutes with the scheduler `configured` means the runs are failing;
 * check the route's logs. Names and counts only: no wallet, user or secret.
 *
 * 404 for anyone else, as the other admin routes answer.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdmin(user)) return Response.json({ error: "Not found" }, { status: 404 });

  const admin = createSupabaseAdminClient();
  const [scheduler, counts, oldest] = await Promise.all([
    readSchedulerHealth(admin),
    Promise.all(
      OPEN_STATUSES.map(async (status) => {
        const { count, error } = await admin
          .from("workspace_chain_jobs")
          .select("id", { count: "exact", head: true })
          .eq("status", status);
        return [status, error ? null : (count ?? 0)] as const;
      }),
    ),
    admin
      .from("workspace_chain_jobs")
      .select("created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  return Response.json({
    registryEditors: REGISTRY_EDITORS,
    scheduler,
    warning: schedulerWarning(scheduler),
    jobs: Object.fromEntries(counts),
    oldestPendingAt: (oldest.data?.created_at as string | undefined) ?? null,
  });
}
