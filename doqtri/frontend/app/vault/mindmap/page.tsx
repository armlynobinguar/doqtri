import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadVaultDocs } from "@/lib/load-docs";
import { getActiveWorkspace } from "@/lib/active-workspace";
import { loadMindmapStyle } from "@/lib/load-mindmap-style";
import { qditHackathonEnabled, qditPublicOrigin } from "@/lib/integrations/qdit-config";
import { canSendToHackathon } from "@/lib/integrations/qdit-hackathon-send";
import { roleAtLeast } from "@/lib/workspace-roles";
import type { WorkspaceChoice } from "@/lib/workspace-scope";
import { WorkspaceGuard } from "@/components/vault/workspace-guard";
import { GlobalMindmap } from "@/components/vault/global-mindmap";
import type { HackathonSendSetup, LinkedQditProject } from "@/components/vault/send-to-hackathon-dialog";

/**
 * The vault-wide mindmap: every note of the active workspace (WP-1.7).
 *
 * This is a static segment, so it wins over the sibling `[docId]` route and
 * `/vault/mindmap` can never be read as a note id.
 */
export default async function GlobalMindmapPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { active: workspace } = await getActiveWorkspace(user.id);
  const [docs, savedStyle, hackathon] = await Promise.all([
    loadVaultDocs(supabase, workspace.id),
    loadMindmapStyle(supabase, user.id, "global"),
    hackathonSetup(supabase, workspace),
  ]);

  return (
    <>
      <WorkspaceGuard workspaceId={workspace.id} />
      <GlobalMindmap docs={docs} savedStyle={savedStyle} hackathon={hackathon} />
    </>
  );
}

/**
 * What "Send to qdit hackathon" needs (WP-4.7, D-117), or null when the
 * button is hidden: the flag off, qdit's origin unknown, the user below admin
 * here (D-10), or qdit not connected. Read as the user: my_integration_connections() returns no
 * tokens, and RLS shows the workspace's note links to its members.
 */
async function hackathonSetup(
  supabase: SupabaseClient,
  workspace: Pick<WorkspaceChoice, "id" | "name" | "role">,
): Promise<HackathonSendSetup | null> {
  // Without qdit's origin the route refuses every send (503), so no button.
  const qditOrigin = qditPublicOrigin();
  if (!qditHackathonEnabled() || !qditOrigin || !roleAtLeast(workspace.role, "admin")) return null;

  const [{ data: conns, error: connError }, { data: links, error: linkError }] = await Promise.all([
    supabase.rpc("my_integration_connections"),
    supabase
      .from("doc_project_links")
      .select("project_id, project_name, documents!inner(workspace_id)")
      .eq("documents.workspace_id", workspace.id),
  ]);
  if (connError) return null;
  const qdit = ((conns ?? []) as { provider: string; status: string }[]).find((c) => c.provider === "qdit");
  if (!canSendToHackathon(workspace.role, qdit?.status === "connected")) return null;

  // One entry per project, by name. A failed read only loses the "linked
  // here" ordering: the dialog still lists the user's qdit projects.
  const linked = new Map<string, LinkedQditProject>();
  if (!linkError) {
    for (const row of (links ?? []) as { project_id: string; project_name: string }[]) {
      linked.set(row.project_id, { id: row.project_id, name: row.project_name });
    }
  }
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    qditOrigin,
    linkedProjects: [...linked.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}
