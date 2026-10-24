import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { ProfileView, type ReferralSummary } from "@/components/vault/profile-view";
import { referralUrl } from "@/lib/referral";
import { getActiveWorkspace } from "@/lib/active-workspace";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConnectedAppsData } from "@/components/vault/connected-apps";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";

export const metadata: Metadata = {
  title: "Profile & wallet · Doqtri",
  robots: { index: false },
};

/**
 * The signed-in user's account and wallet on one page: how they sign in, the
 * wallet that anchors their notes, its balance, passkeys and recent on-chain
 * writes. A static segment, so it wins over `[docId]`; it renders inside the
 * vault shell, which provides the wallet.
 */
export default async function ProfilePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [referral, { active }, connectedApps] = await Promise.all([
    loadReferral(user.id),
    getActiveWorkspace(user.id),
    qditIntegrationEnabled() ? loadConnectedApps(supabase) : Promise.resolve(null),
  ]);
  return (
    <Suspense>
      <ProfileView
        joinedAt={user.created_at}
        referral={referral}
        workspaceId={active.id}
        connectedApps={connectedApps}
      />
    </Suspense>
  );
}

/**
 * The user's referral link, creating their code on first visit, and how many
 * accounts signed up through it. Null (the section is hidden) if it can't be
 * loaded, e.g. before the referrals migration is applied.
 */
async function loadReferral(userId: string): Promise<ReferralSummary | null> {
  // Service role: userId comes from the verified session in the page above.
  const { data, error } = await createSupabaseAdminClient()
    .rpc("referral_code_for", { p_user_id: userId })
    .single<{ code: string; referred: number }>();
  if (error || !data) {
    if (error) console.warn(`[profile] referral not loaded: ${error.message}`);
    return null;
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return { url: referralUrl(`${proto}://${host}`, data.code), referred: data.referred };
}

type ConnectionRow = {
  provider: string;
  subject: string;
  account_label: string | null;
  status: "connected" | "needs_reconnect" | "revoked";
  connected_at: string;
};

/**
 * The user's qdit connection for Connected apps (WP-2.3), read as the user
 * through my_integration_connections(), which never returns a token.
 */
async function loadConnectedApps(supabase: SupabaseClient): Promise<ConnectedAppsData> {
  const { data, error } = await supabase.rpc("my_integration_connections");
  if (error) {
    console.warn(`[profile] connected apps not loaded: ${error.message}`);
    return { qdit: null, unavailable: true };
  }
  const row = ((data ?? []) as ConnectionRow[]).find((r) => r.provider === "qdit");
  return {
    qdit: row
      ? { status: row.status, subject: row.subject, accountLabel: row.account_label, connectedAt: row.connected_at }
      : null,
  };
}
