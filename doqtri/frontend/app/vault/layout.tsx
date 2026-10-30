import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin";
import { getActiveWorkspace } from "@/lib/active-workspace";
import { VaultShell } from "@/components/vault/vault-shell";
import { PreferencesSync } from "@/components/vault/preferences";
import { ReferralClaim } from "@/components/vault/referral-claim";
import { REFERRAL_COOKIE } from "@/lib/referral";
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

  // Anon key + RLS: only documents the caller may read, and of those only
  // the active workspace's (WP-1.7). The pages inside resolve the same
  // workspace from the same per-request cache.
  const { active, workspaces } = await getActiveWorkspace(user.id);
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, updated_at")
    .eq("workspace_id", active.id)
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
    const [{ data: wallet }, { data: passkeys }] = await Promise.all([
      supabase.from("smart_wallets").select("address, created_tx").eq("network", NETWORK).maybeSingle(),
      supabase
        .from("wallet_passkeys")
        .select("credential_id, public_key, created_at")
        .eq("network", NETWORK)
        .order("created_at", { ascending: true }),
    ]);
    identity = {
      kind: "email",
      email: user.email ?? "",
      smartWallet:
        wallet && passkeys?.length
          ? {
              address: wallet.address,
              createdTx: wallet.created_tx,
              passkeys: passkeys.map((p) => ({
                credentialId: p.credential_id as string,
                // bytea arrives as "\x" + hex over PostgREST.
                publicKey: String(p.public_key).replace(/^\\x/, ""),
                createdAt: p.created_at as string,
              })),
            }
          : null,
    };
  }

  // Opened someone's referral link before signing up: record it once.
  const hasReferral = (await cookies()).has(REFERRAL_COOKIE);

  return (
    <>
      <PreferencesSync account={user.user_metadata?.preferences ?? null} />
      {hasReferral && <ReferralClaim />}
      <VaultShell
        notes={notes}
        failedImports={failedImports}
        identity={identity}
        isAdmin={isAdmin(user)}
        workspace={active}
        workspaces={workspaces}
      >
        {children}
      </VaultShell>
    </>
  );
}
