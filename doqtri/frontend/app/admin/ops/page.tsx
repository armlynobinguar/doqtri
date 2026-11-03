import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { OpsBoard, type BillingLink } from "@/components/admin/ops-board";
import { isAdmin } from "@/lib/admin";
import { collectOps } from "@/lib/ops/collect";
import { liveOpsDeps } from "@/lib/ops/deps";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Ops · Doqtri admin",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

/** The Supabase project ref, from NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co). */
function supabaseRef(): string | null {
  try {
    const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] : null;
  } catch {
    return null;
  }
}

function billingLinks(): BillingLink[] {
  const ref = supabaseRef();
  return [
    { label: "OpenAI usage", href: "https://platform.openai.com/usage" },
    { label: "Vercel usage", href: "https://vercel.com/dashboard" },
    {
      label: "Supabase usage",
      href: ref ? `https://supabase.com/dashboard/project/${ref}/settings/billing/usage` : "https://supabase.com/dashboard",
    },
    { label: "OpenZeppelin Channels", href: "https://channels.openzeppelin.com" },
  ];
}

/**
 * The ops dashboard (DOQ-14, WP-4.3): spendable balances and quotas, queue
 * statuses and health checks for this deployment. Admins only
 * (DOQTRI_ADMINS); anyone else gets a 404. The first report is read here;
 * the board then asks /api/admin/ops again every minute.
 */
export default async function OpsAdminPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdmin(user)) notFound();

  const report = await collectOps(liveOpsDeps(createSupabaseAdminClient()));

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--glass-lo)] px-4 py-4 sm:px-8">
        <Link href="/vault" className="flex items-center gap-2 text-[17px] font-extrabold tracking-[-0.045em]">
          <DoqtriMark className="h-auto w-6" glow={false} title="" />
          Doqtri
          <span className="eyebrow ml-1 text-[10px]">Admin</span>
        </Link>
        <nav className="flex gap-4">
          <Link href="/admin/reports" className="eyebrow hover:text-foreground transition-colors">
            Reports
          </Link>
          <Link href="/admin/promo" className="eyebrow hover:text-foreground transition-colors">
            Promo entries
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8">
        <h1 className="display text-3xl">Ops</h1>
        <p className="text-muted-foreground mt-3 mb-8 text-[14px]">
          What can run out, what is queued, and whether the scheduled runs work. Worst first; refreshes every minute.
        </p>
        <OpsBoard initial={report} billing={billingLinks()} />
      </main>
    </div>
  );
}
