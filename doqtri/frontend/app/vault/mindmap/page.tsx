import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadVaultDocs } from "@/lib/load-docs";
import { getActiveWorkspace } from "@/lib/active-workspace";
import { loadMindmapStyle } from "@/lib/load-mindmap-style";
import { GlobalMindmap } from "@/components/vault/global-mindmap";

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
  const [docs, savedStyle] = await Promise.all([
    loadVaultDocs(supabase, workspace.id),
    loadMindmapStyle(supabase, user.id, "global"),
  ]);

  return <GlobalMindmap docs={docs} savedStyle={savedStyle} />;
}
