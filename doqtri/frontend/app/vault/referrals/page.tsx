import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ReferralsView } from "@/components/vault/referrals-view";
import { referralUrl } from "@/lib/referral";
import { referralDashboardLive } from "@/lib/referral-dashboard";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

/** Nothing of its own while off, so it reads like any other unknown path under /vault. */
export function generateMetadata(): Metadata {
  if (!referralDashboardLive()) return {};
  return { title: "Referrals · Doqtri", robots: { index: false } };
}

/**
 * Who signed up with the user's link and what they've earned (WP-4.6, DOQ-24).
 * A static segment, so it wins over `[docId]`; it renders inside the vault
 * shell. Doesn't exist until the legal pages go live. The list comes from
 * /api/referrals.
 */
export default async function ReferralsPage() {
  if (!referralDashboardLive()) notFound();

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <ReferralsView inviteUrl={await loadInviteUrl(user.id)} />;
}

/** The user's link for the empty state; null sends them to the Invite tab instead. */
async function loadInviteUrl(userId: string): Promise<string | null> {
  // Service role: userId comes from the verified session in the page above.
  const { data, error } = await createSupabaseAdminClient()
    .rpc("referral_code_for", { p_user_id: userId })
    .single<{ code: string }>();
  if (error || !data) {
    if (error) console.warn(`[referrals] invite link not loaded: ${error.message}`);
    return null;
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return referralUrl(`${proto}://${host}`, data.code);
}
