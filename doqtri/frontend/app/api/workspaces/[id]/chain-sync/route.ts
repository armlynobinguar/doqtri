import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { REGISTRY_EDITORS } from "@/lib/stellar/config";
import { runChainJobs } from "@/lib/stellar/chain-jobs";
import { chainSyncGate, rlsVisibility } from "@/lib/chain-sync-access";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Works the workspace's on-chain follow-ups now (chain-jobs.ts): the members
 * screen calls this right after removing, demoting or handing over, so a
 * removal reaches the chain within a ledger or two (D-16), and again on
 * load, to retry anything still pending.
 *
 * Open to the workspace's members and to anyone a pending job is about (a
 * member who just left is no longer a member): chainSyncGate. Every job only
 * brings the chain in line with the database, so running it early is never
 * harmful. With REGISTRY_EDITORS off nothing is sent.
 */
export async function POST(_request: Request, context: RouteContext<"/api/workspaces/[id]/chain-sync">) {
  const { id } = await context.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // RLS, through the caller's own client: the workspace as a member, its
  // jobs as an admin, their own job as its subject (chain-sync-access.ts).
  const gate = await chainSyncGate(user?.id ?? null, id, rlsVisibility(supabase));
  if (!gate.ok) return Response.json({ error: gate.error }, { status: gate.status });
  if (!REGISTRY_EDITORS) return Response.json({ skipped: true, done: 0, pending: 0, failed: 0, needsProductOwner: 0 });

  try {
    return Response.json(await runChainJobs(createSupabaseAdminClient(), { workspaceId: id, limit: 10 }));
  } catch (error) {
    console.error("[workspaces/chain-sync] failed", error);
    return Response.json({ error: "On-chain updates couldn't run right now." }, { status: 503 });
  }
}
