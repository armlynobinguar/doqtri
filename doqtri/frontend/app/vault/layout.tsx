import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { VaultShell } from "@/components/vault/vault-shell";
import type { NoteSummary } from "@/lib/types";

export default async function VaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // proxy.ts already guards this, but the layout must not render a vault
  // without a verified user.
  if (!user) redirect("/login");

  // Anon key + RLS: this can only ever return the caller's own rows.
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, updated_at")
    .order("title", { ascending: true });

  if (error) throw new Error(`Failed to load vault: ${error.message}`);

  const notes: NoteSummary[] = data ?? [];
  const wallet =
    typeof user.user_metadata?.wallet_address === "string"
      ? user.user_metadata.wallet_address
      : user.email ?? "";

  return (
    <VaultShell notes={notes} email={wallet}>
      {children}
    </VaultShell>
  );
}
