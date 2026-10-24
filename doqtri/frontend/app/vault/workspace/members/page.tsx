import type { Metadata } from "next";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/active-workspace";
import { REGISTRY_EDITORS } from "@/lib/stellar/config";
import { runChainJobs } from "@/lib/stellar/chain-jobs";
import { MembersView } from "@/components/vault/members-view";

export const metadata: Metadata = {
  title: "Workspace members · Doqtri",
  robots: { index: false },
};

/**
 * Who is in a workspace and with which role (WP-1.5): invites, role
 * changes, removal, leaving and handing the workspace on, and whether each
 * member's on-chain role has caught up. `?ws=` picks the workspace; without
 * it (or naming one the user is not in), the vault's active workspace, so
 * the screen opens on the workspace the user was looking at. A static
 * segment, so it wins over `[docId]`.
 */
export default async function MembersPage(props: PageProps<"/vault/workspace/members">) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The same reads as the vault layout (cached per request): the user's
  // workspaces, and the one this browser has active (D-55).
  const [{ active, workspaces }, searchParams] = await Promise.all([getActiveWorkspace(user.id), props.searchParams]);

  const requested = typeof searchParams.ws === "string" ? searchParams.ws : null;
  const workspaceId = workspaces.some((w) => w.id === requested) ? requested! : active.id;

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
