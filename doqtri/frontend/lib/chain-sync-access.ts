/**
 * Who may ask the server to work a workspace's on-chain queue now
 * (/api/workspaces/[id]/chain-sync, WP-1.5).
 *
 * Running the queue spends the server's keys (the revoke-only key, and the
 * contract admin's when configured), so it is open only to the workspace's
 * members and to anyone a pending job is about: a member who has just left
 * or been removed is no longer a member, yet their own removal should still
 * reach the chain promptly (D-16). Both are asked of the database through
 * the caller's own client, so RLS decides: a member sees the workspace, an
 * admin its jobs, and the subject of a job that job. Anything that cannot
 * be confirmed (a failed query included) is refused, as if the workspace
 * did not exist.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the caller can see of a workspace, through RLS. Null when the query failed. */
export type WorkspaceVisibility = {
  /** Rows of the workspace itself the caller sees: 1 for a member. */
  workspace(workspaceId: string): Promise<number | null>;
  /** The workspace's chain jobs the caller sees: all for an admin, their own for a job's subject. */
  jobs(workspaceId: string): Promise<number | null>;
};

export type ChainSyncGate = { ok: true } | { ok: false; status: 401 | 404; error: string };

const NOT_A_WORKSPACE = { ok: false, status: 404, error: "That isn't a workspace." } as const;

export async function chainSyncGate(
  userId: string | null,
  workspaceId: string,
  visibility: WorkspaceVisibility,
): Promise<ChainSyncGate> {
  if (!UUID.test(workspaceId)) return NOT_A_WORKSPACE;
  if (!userId) return { ok: false, status: 401, error: "Sign in to continue." };
  const [workspaces, jobs] = await Promise.all([visibility.workspace(workspaceId), visibility.jobs(workspaceId)]);
  if (!workspaces && !jobs) return NOT_A_WORKSPACE;
  return { ok: true };
}

/** WorkspaceVisibility through the signed-in user's Supabase client (never the service role). */
export function rlsVisibility(supabase: SupabaseClient): WorkspaceVisibility {
  return {
    async workspace(workspaceId) {
      const { count, error } = await supabase.from("workspaces").select("id", { count: "exact", head: true }).eq("id", workspaceId);
      return error ? null : count;
    },
    async jobs(workspaceId) {
      const { count, error } = await supabase
        .from("workspace_chain_jobs")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId);
      return error ? null : count;
    },
  };
}
