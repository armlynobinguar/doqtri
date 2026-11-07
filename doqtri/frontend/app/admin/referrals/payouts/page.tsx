import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { ReferralPayouts } from "@/components/admin/referral-payouts";
import { isAdmin } from "@/lib/admin";
import { loadPayoutQueue } from "@/lib/referral-payouts-store";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Referral payouts · Doqtri admin",
  robots: { index: false },
};

/**
 * Referral payouts (WP-4.6, DOQ-26): who is owed what, where to send it and by
 * when, and the actions to record a payout, void or restore a reward, and set a
 * referrer's limit. Admins only (DOQTRI_ADMINS); anyone else, signed out
 * included, gets a 404. Not behind the legal pages' switch: admins need to see
 * eligibility before launch. Read with the service role. Payout details show in
 * full here and nowhere else; nothing on this page sends money. Paying is two
 * steps (lib/referral-payouts-store.ts): Start payout holds it for this admin and
 * shows the details as they are now, then Record payout records what was sent.
 */
export default async function ReferralPayoutsAdminPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user)) notFound();

  const rows = await loadPayoutQueue(createSupabaseAdminClient(), user.id);

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--glass-lo)] px-4 py-4 sm:px-8">
        <Link href="/vault" className="flex items-center gap-2 text-[17px] font-extrabold tracking-[-0.045em]">
          <DoqtriMark className="h-auto w-6" glow={false} title="" />
          Doqtri
          <span className="eyebrow ml-1 text-[10px]">Admin</span>
        </Link>
        <Link href="/admin/referrals" className="eyebrow hover:text-foreground transition-colors">
          Referrals
        </Link>
      </header>

      <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-8 sm:px-8">
        <h1 className="display text-3xl">Referral payouts</h1>
        <p className="text-muted-foreground mt-3 text-[14px]">
          Referrers with rewards to pay, waiting over their limit, or voided, soonest due first. Expand a referrer to
          review the accounts they referred before paying.
        </p>
        <ReferralPayouts initialRows={rows} />
      </main>
    </div>
  );
}
