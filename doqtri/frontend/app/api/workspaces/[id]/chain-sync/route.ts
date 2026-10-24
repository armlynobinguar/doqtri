import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { REGISTRY_EDITORS } from "@/lib/stellar/config";
import { runChainJobs } from "@/lib/stellar/chain-jobs";

export const runtime = "nodejs";
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Works the workspace's on-chain follow-ups now (chain-jobs.ts): the members
 * screen calls this right after removing, demoting or handing over, so a
 * removal reaches the chain within a ledger or two (D-16), and again on
 * load, to retry anything still pending.
 *
 * Open to the workspace's members and to anyone a pending job is about (a
 * member who just left is no longer a member). Every job only brings the
 * chain in line with the database, so running it early is never harmful.
 * With REGISTRY_EDITORS off nothing is sent.
 */
export async function POST(_request: Request, context: RouteContext<"/api/workspaces/[id]/chain-sync">) {
  const { id } = await context.params;
  if (!UUID.test(id)) return Response.json({ error: "That isn't a workspace." }, { status: 404 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (!REGISTRY_EDITORS) return Response.json({ skipped: true, done: 0, pending: 0, failed: 0, needsProductOwner: 0 });

  // RLS: the caller sees the workspace's jobs as its admin, their own as
  // their subject, and the workspace itself as a member.
  const [{ count: memberships }, { count: ownJobs }] = await Promise.all([
    supabase.from("workspaces").select("id", { count: "exact", head: true }).eq("id", id),
    supabase.from("workspace_chain_jobs").select("id", { count: "exact", head: true }).eq("workspace_id", id),
  ]);
  if (!memberships && !ownJobs) return Response.json({ error: "That isn't a workspace." }, { status: 404 });

  try {
    return Response.json(await runChainJobs(createSupabaseAdminClient(), { workspaceId: id, limit: 10 }));
  } catch (error) {
    console.error("[workspaces/chain-sync] failed", error);
    return Response.json({ error: "On-chain updates couldn't run right now." }, { status: 503 });
  }
}
