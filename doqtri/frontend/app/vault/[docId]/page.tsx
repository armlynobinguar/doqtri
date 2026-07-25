import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DocWorkspace } from "@/components/vault/doc-workspace";
import type { Doc } from "@/lib/types";

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
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, markdown")
    .order("title", { ascending: true });

  if (error) throw new Error(`Failed to load vault: ${error.message}`);

  const docs: Doc[] = data ?? [];
  const active = docs.find((doc) => doc.id === docId);
  if (!active) notFound();

  // Remount on note change instead of reconciling editor state across notes.
  return <DocWorkspace key={active.id} docs={docs} active={active} />;
}
