import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadVaultDocs } from "@/lib/load-docs";
import { DocWorkspace } from "@/components/vault/doc-workspace";

export default async function DocPage(props: PageProps<"/vault/[docId]">) {
  const { docId } = await props.params;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  /*
   * The global graph spans the whole vault, so every note's markdown is
   * fetched and the graph is built client-side. RLS keeps this to the caller's
   * own rows. If a vault ever grows past what is reasonable to ship to the
   * client, the fix is pagination — not a stored graph table.
   */
  const docs = await loadVaultDocs(supabase);
  const active = docs.find((doc) => doc.id === docId);
  if (!active) notFound();

  // Remount on note change instead of reconciling editor state across notes.
  return <DocWorkspace key={active.id} docs={docs} active={active} />;
}
