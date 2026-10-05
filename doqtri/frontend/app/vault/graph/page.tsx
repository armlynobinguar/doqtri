import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadVaultDocs } from "@/lib/load-docs";
import { GlobalGraph } from "@/components/vault/global-graph";

/**
 * The vault-wide link graph, given the whole pane.
 *
 * This is a static segment, so it wins over the sibling `[docId]` route and
 * `/vault/graph` can never be read as a note id.
 */
export default async function GlobalGraphPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const docs = await loadVaultDocs(supabase);

  return <GlobalGraph docs={docs} />;
}
