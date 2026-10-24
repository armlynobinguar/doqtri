import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadVaultDocs } from "@/lib/load-docs";
import { crossWorkspaceRedirect, getActiveWorkspace } from "@/lib/active-workspace";
import { loadMindmapStyle } from "@/lib/load-mindmap-style";
import { DocumentMindmap } from "@/components/vault/document-mindmap";

/**
 * The full-screen mindmap of one document. Nested inside the vault layout, so
 * it keeps the ribbon, explorer, and status bar.
 */
export default async function DocMindmapPage(
  props: PageProps<"/vault/[docId]/mindmap">,
) {
  const { docId } = await props.params;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { active: workspace } = await getActiveWorkspace(user.id);
  const [docs, savedStyle] = await Promise.all([
    loadVaultDocs(supabase, workspace.id),
    loadMindmapStyle(supabase, user.id, `doc:${docId}`),
  ]);
  const active = docs.find((doc) => doc.id === docId);
  if (!active) {
    const other = await crossWorkspaceRedirect(supabase, {
      docId,
      activeId: workspace.id,
      next: `/vault/${docId}/mindmap`,
    });
    if (other) redirect(other);
    notFound();
  }

  return (
    <DocumentMindmap
      key={active.id}
      docId={active.id}
      title={active.title}
      markdown={active.markdown}
      mindmap={active.mindmap ?? null}
      stale={active.mindmapStale ?? false}
      savedStyle={savedStyle}
    />
  );
}
