import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadVaultSnapshot } from "@/lib/load-docs";
import { crossWorkspaceRedirect, getActiveWorkspace } from "@/lib/active-workspace";
import { WorkspaceGuard } from "@/components/vault/workspace-guard";
import { NoteSnapshotSeed } from "@/components/vault/note-store";

export default async function DocPage(props: PageProps<"/vault/[docId]">) {
  const { docId } = await props.params;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  /*
   * The global graph spans the whole vault, so every note's markdown is
   * fetched and the graph is built client-side, from the active workspace's
   * notes only (WP-1.7); RLS keeps it to rows the caller may read. If a vault ever grows past what is reasonable to ship to the
   * client, the fix is pagination — not a stored graph table.
   */
  const { active: workspace } = await getActiveWorkspace(user.id);
  const { docs, loadedAt } = await loadVaultSnapshot(supabase, workspace.id);
  const active = docs.find((doc) => doc.id === docId);
  if (!active) {
    // A link to a note in another of the caller's workspaces: switch to it.
    const other = await crossWorkspaceRedirect(supabase, {
      docId,
      activeId: workspace.id,
      next: `/vault/${docId}`,
    });
    if (other) redirect(other);
    notFound();
  }

  // The editor itself is hosted by the vault shell, fed from this snapshot,
  // so a switch to another note of the workspace needs no server render
  // (DOQ-43, components/vault/note-store.tsx).
  return (
    <>
      <WorkspaceGuard workspaceId={workspace.id} />
      <NoteSnapshotSeed workspaceId={workspace.id} loadedAt={loadedAt} docs={docs} docId={active.id} />
    </>
  );
}
