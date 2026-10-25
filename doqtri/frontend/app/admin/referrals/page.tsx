import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { ReferralReport, type RecentReferral, type ReferrerEntry } from "@/components/admin/referral-report";
import { isAdmin } from "@/lib/admin";
import { loadReferrals, summarizeReferrals } from "@/lib/referral-report";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { walletAddressFromEmail } from "@/lib/wallet-address";

export const metadata: Metadata = {
  title: "Referrals · Doqtri admin",
  robots: { index: false },
};

/** Rows shown in each list; the totals above them count everything. */
const TOP_REFERRERS = 50;
const RECENT_REFERRALS = 100;

/**
 * Referral tracking: how many accounts signed up through a referral, how the
 * code reached them (link, QR code or typed in), who refers the most, and the
 * latest referred sign-ups. Admins only (DOQTRI_ADMINS); anyone else gets a
 * 404. Read with the service role, since referrals are never exposed to the
 * browser otherwise.
 */
export default async function ReferralsAdminPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdmin(user)) notFound();

  const admin = createSupabaseAdminClient();
  const [rows, codes] = await Promise.all([
    loadReferrals(admin),
    admin.from("referral_codes").select("*", { count: "exact", head: true }),
  ]);
  if (codes.error) throw new Error(`Failed to count referral codes: ${codes.error.message}`);

  const summary = summarizeReferrals(rows);
  const top = summary.referrers.slice(0, TOP_REFERRERS);
  const recent = rows.slice(0, RECENT_REFERRALS);

  // An email, or the wallet behind a wallet login's synthetic one, for only
  // the accounts on screen.
  const ids = new Set([
    ...top.map((r) => r.userId),
    ...recent.flatMap((r) => [r.referrer_user_id, r.referred_user_id]),
  ]);
  const owners = new Map<string, string>();
  await Promise.all(
    [...ids].map(async (id) => {
      const { data: found } = await admin.auth.admin.getUserById(id);
      const email = found.user?.email;
      owners.set(id, walletAddressFromEmail(email) ?? email ?? id);
    }),
  );
  const owner = (id: string) => owners.get(id) ?? id;

  const referrers: ReferrerEntry[] = top.map((r) => ({ ...r, owner: owner(r.userId) }));
  const latest: RecentReferral[] = recent.map((r) => ({
    referredId: r.referred_user_id,
    referred: owner(r.referred_user_id),
    referrer: owner(r.referrer_user_id),
    code: r.code,
    source: r.source,
    createdAt: r.created_at,
  }));

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--glass-lo)] px-4 py-4 sm:px-8">
        <Link href="/vault" className="flex items-center gap-2 text-[17px] font-extrabold tracking-[-0.045em]">
          <DoqtriMark className="h-auto w-6" glow={false} title="" />
          Doqtri
          <span className="eyebrow ml-1 text-[10px]">Admin</span>
        </Link>
        <Link href="/vault/profile?tab=invite" className="eyebrow hover:text-foreground transition-colors">
          Your invite link
        </Link>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8">
        <h1 className="display text-3xl">Referrals</h1>
        <p className="text-muted-foreground mt-3 text-[14px]">
          Accounts that signed up through someone&apos;s link, QR code or referral code. A referral counts only for an
          account created after the code was seen.
        </p>
        <ReferralReport
          total={summary.total}
          via={summary.via}
          last7Days={summary.last7Days}
          last30Days={summary.last30Days}
          codes={codes.count ?? 0}
          referrerCount={summary.referrers.length}
          referrers={referrers}
          recent={latest}
        />
      </main>
    </div>
  );
}
