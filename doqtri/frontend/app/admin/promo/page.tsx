import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import {
  PromoReviewList,
  type PromoEntry,
} from "@/components/admin/promo-review-list";
import { isAdmin } from "@/lib/admin";
import { MINDMAP_PROMO, PROMO_BUCKET, isPromoStatus } from "@/lib/promo";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import { walletAddressFromEmail } from "@/lib/wallet-address";

export const metadata: Metadata = {
  title: "Promo entries · Doqtri admin",
  robots: { index: false },
};

type Row = {
  id: string;
  user_id: string;
  image_paths: string[];
  caption: string;
  contact: string;
  status: string;
  created_at: string;
  updated_at: string;
};

/**
 * Review screen for the mindmap showcase. Admins only (DOQTRI_ADMINS); anyone
 * else gets a 404. Everything is read with the service role, since entries are
 * otherwise visible only to their owners.
 */
export default async function PromoAdminPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdmin(user)) notFound();

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("promo_submissions")
    .select("id, user_id, image_paths, caption, contact, status, created_at, updated_at")
    .eq("promo", MINDMAP_PROMO.id)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load entries: ${error.message}`);
  const rows = (data ?? []) as Row[];

  // One signing call for every screenshot on the page.
  const paths = rows.flatMap((row) => row.image_paths);
  const urlByPath = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await admin.storage
      .from(PROMO_BUCKET)
      .createSignedUrls(paths, 60 * 60);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
    }
  }

  // Who submitted: an email, or the wallet behind a wallet login's synthetic one.
  const owners = new Map<string, string>();
  await Promise.all(
    [...new Set(rows.map((row) => row.user_id))].map(async (id) => {
      const { data: found } = await admin.auth.admin.getUserById(id);
      const email = found.user?.email;
      owners.set(id, walletAddressFromEmail(email) ?? email ?? id);
    }),
  );

  const entries: PromoEntry[] = rows.map((row) => ({
    id: row.id,
    owner: owners.get(row.user_id) ?? row.user_id,
    imageUrls: row.image_paths.flatMap((p) => {
      const url = urlByPath.get(p);
      return url ? [url] : [];
    }),
    caption: row.caption,
    contact: row.contact,
    status: isPromoStatus(row.status) ? row.status : "pending",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--glass-lo)] px-4 py-4 sm:px-8">
        <Link href="/vault" className="flex items-center gap-2 text-[17px] font-extrabold tracking-[-0.045em]">
          <DoqtriMark className="h-auto w-6" glow={false} title="" />
          Doqtri
          <span className="eyebrow ml-1 text-[10px]">
            Admin
          </span>
        </Link>
        <Link href="/promo" className="eyebrow hover:text-foreground transition-colors">
          View portal
        </Link>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8">
        <h1 className="display text-3xl">Beta launch promo entries</h1>
        <p className="text-muted-foreground mt-3 text-[14px]">
          Promo <code className="font-mono text-[13px]">{MINDMAP_PROMO.id}</code> ·{" "}
          {MINDMAP_PROMO.active ? "open for entries" : "closed"} · prize pool {MINDMAP_PROMO.prizePool}
        </p>
        <PromoReviewList entries={entries} />
      </main>
    </div>
  );
}
