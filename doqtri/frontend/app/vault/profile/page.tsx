import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { ProfileView, type ReferralSummary } from "@/components/vault/profile-view";
import { referralUrl } from "@/lib/referral";

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

  const referral = await loadReferral(user.id);
  return (
    <Suspense>
      <ProfileView joinedAt={user.created_at} referral={referral} />
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
