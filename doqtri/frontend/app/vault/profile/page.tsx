import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ProfileView } from "@/components/vault/profile-view";

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

  return <ProfileView joinedAt={user.created_at} />;
}
