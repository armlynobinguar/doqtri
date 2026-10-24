import type { Metadata } from "next";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { personalWorkspaceId } from "@/lib/workspace-docs";
import { REGISTRY_EDITORS } from "@/lib/stellar/config";
import { runChainJobs } from "@/lib/stellar/chain-jobs";
import { MembersView, type WorkspaceChoice } from "@/components/vault/members-view";
import type { WorkspaceRole } from "@/lib/workspace-roles";

export const metadata: Metadata = {
  title: "Workspace members · Doqtri",
  robots: { index: false },
};

/**
 * Who is in a workspace and with which role (WP-1.5): invites, role
 * changes, removal, leaving and handing the workspace on, and whether each
 * member's on-chain role has caught up. `?ws=` picks the workspace; without
 * it, the personal one. A static segment, so it wins over `[docId]`.
 */
export default async function MembersPage(props: PageProps<"/vault/workspace/members">) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [personalId, { data: rows, error }, searchParams] = await Promise.all([
    personalWorkspaceId(supabase, user.id),
    // RLS: the caller's own memberships, and the workspaces they are in.
    supabase.from("workspace_members").select("role, workspaces(id, name, is_personal)").eq("user_id", user.id),
    props.searchParams,
  ]);
  if (error) throw new Error(`Could not load your workspaces: ${error.message}`);

  const workspaces: WorkspaceChoice[] = (rows ?? [])
    .map((row) => {
      const embedded = row.workspaces as unknown as { id: string; name: string; is_personal: boolean } | null;
      return embedded
        ? { id: embedded.id, name: embedded.name, personal: embedded.is_personal, role: row.role as WorkspaceRole }
        : null;
    })
    .filter((w): w is WorkspaceChoice => w !== null)
    .sort((a, b) => Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name));

  const requested = typeof searchParams.ws === "string" ? searchParams.ws : null;
  const workspaceId = workspaces.some((w) => w.id === requested) ? requested! : personalId;

  // Retry anything still owed to the chain for this workspace (D-16).
  if (REGISTRY_EDITORS) {
    after(() =>
      runChainJobs(createSupabaseAdminClient(), { workspaceId, limit: 10 }).catch((e) =>
        console.error("[members] chain jobs", e),
      ),
    );
  }

  return <MembersView userId={user.id} workspaces={workspaces} workspaceId={workspaceId} />;
}
