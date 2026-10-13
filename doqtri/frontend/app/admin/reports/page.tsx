import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { MarketReportList } from "@/components/admin/market-report-list";
import { isAdmin } from "@/lib/admin";
import { loadReportQueue } from "@/lib/market-server";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Template reports · Doqtri admin",
  robots: { index: false },
};

/**
 * Copy reports on community templates (progress/004). Admins only
 * (DOQTRI_ADMINS); anyone else gets a 404. The earlier on-chain listing wins;
 * upholding a report hides the copy from the gallery, never the contract
 * listing.
 */
export default async function ReportsAdminPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdmin(user)) notFound();

  const reports = await loadReportQueue(createSupabaseAdminClient());

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--glass-lo)] px-4 py-4 sm:px-8">
        <Link href="/vault" className="flex items-center gap-2 text-[17px] font-extrabold tracking-[-0.045em]">
          <DoqtriMark className="h-auto w-6" glow={false} title="" />
          Doqtri
          <span className="eyebrow ml-1 text-[10px]">Admin</span>
        </Link>
        <Link href="/admin/promo" className="eyebrow hover:text-foreground transition-colors">
          Promo entries
        </Link>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8">
        <h1 className="display text-3xl">Template copy reports</h1>
        <p className="text-muted-foreground mt-3 text-[14px]">
          Network <code className="font-mono text-[13px]">{NETWORK}</code> · the earlier on-chain listing wins.
          Upholding hides the reported template from the gallery; its contract listing stays.
        </p>
        <MarketReportList reports={reports} />
      </main>
    </div>
  );
}
