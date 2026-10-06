import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { VaultShell } from "@/components/vault/vault-shell";
import { loadFailedImports } from "@/lib/ingest/failed";
import { walletAddressFromEmail } from "@/lib/wallet-address";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import type { NoteSummary, VaultIdentity } from "@/lib/types";

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

  const failedImports = await loadFailedImports(supabase);
  // From the verified email, not user_metadata: the user can rewrite metadata.
  const address = walletAddressFromEmail(user.email);
  let identity: VaultIdentity;
  if (address) {
    identity = { kind: "wallet", address };
  } else {
    // RLS: only the caller's own wallet and passkeys are visible.
    const [{ data: wallet }, { data: passkey }] = await Promise.all([
      supabase.from("smart_wallets").select("address").eq("network", NETWORK).maybeSingle(),
      supabase
        .from("wallet_passkeys")
        .select("credential_id")
        .eq("network", NETWORK)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    identity = {
      kind: "email",
      email: user.email ?? "",
      smartWallet:
        wallet && passkey ? { address: wallet.address, credentialId: passkey.credential_id } : null,
    };
  }

  return (
    <VaultShell notes={notes} failedImports={failedImports} identity={identity}>
      {children}
    </VaultShell>
  );
}
