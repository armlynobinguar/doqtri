import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadVaultDocs } from "@/lib/load-docs";
import { GlobalMindmap } from "@/components/vault/global-mindmap";

/**
 * The vault-wide mindmap.
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

  const docs = await loadVaultDocs(supabase);

  return <GlobalMindmap docs={docs} />;
}
