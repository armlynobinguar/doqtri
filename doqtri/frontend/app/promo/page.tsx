import type { Metadata } from "next";
import Link from "next/link";
import { ConnectWalletButton } from "@/components/auth/connect-wallet-button";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { PromoSubmissionForm } from "@/components/promo/promo-submission-form";
import { MINDMAP_PROMO, PROMO_BUCKET, type PromoSubmission } from "@/lib/promo";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Beta launch promo · Doqtri",
  description: `Doqtri beta is live. Join and share your mindmaps for a chance at the ${MINDMAP_PROMO.prizePool} prize pool.`,
};

/**
 * The submission portal for the mindmap showcase promo. Open to everyone so the
 * landing announcement can link here; only signed-in users get the form.
 */
export default async function PromoPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let submission: PromoSubmission | null = null;
  if (user) {
    // RLS: only the caller's own entry is visible.
    const { data } = await supabase
      .from("promo_submissions")
      .select("image_paths, caption, contact, updated_at")
      .eq("promo", MINDMAP_PROMO.id)
      .maybeSingle();

    if (data) {
      // The bucket has no storage policies, so previews are signed server-side
      // for paths that came from the caller's own row.
      const { data: signed } = await createSupabaseAdminClient()
        .storage.from(PROMO_BUCKET)
        .createSignedUrls(data.image_paths as string[], 60 * 60);
      submission = {
        imageUrls: (signed ?? []).flatMap((s) => (s.signedUrl ? [s.signedUrl] : [])),
        caption: data.caption as string,
        contact: data.contact as string,
        updatedAt: data.updated_at as string,
      };
    }
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-border flex items-center justify-between gap-4 border-b px-4 py-3 sm:px-8">
        <Link
          href={user ? "/vault" : "/"}
          className="flex items-center gap-2 text-[15px] font-bold tracking-tight"
          aria-label={user ? "Back to your vault" : "Doqtri home"}
        >
          <DoqtriMark className="h-auto w-6" glow={false} title="" />
          Doqtri
        </Link>
        {user && (
          <Link
            href="/vault/mindmap"
            className="text-muted-foreground hover:text-foreground text-[13px]"
          >
            Open your mindmap
          </Link>
        )}
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:py-14">
        <p className="text-success font-mono text-[11px] tracking-[0.18em] uppercase">
          Beta launch
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Join the beta and win from a {MINDMAP_PROMO.prizePool} prize pool
        </h1>
        <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">
          {`Doqtri beta is live. Write your first note on anything Web3, screenshot the mindmap it builds, and submit it here. Attach up to ${MINDMAP_PROMO.maxImages} screenshots: a single note’s map, your global mindmap, or both.`}
        </p>

        <ol className="text-muted-foreground mt-6 grid gap-2 text-[14px] sm:grid-cols-2">
          {[
            <>Sign up on Doqtri</>,
            <>
              Follow{" "}
              <a
                href={`https://x.com/${MINDMAP_PROMO.xHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline-offset-4 hover:underline"
              >
                @{MINDMAP_PROMO.xHandle}
              </a>{" "}
              on X
            </>,
            <>Write your first note on anything Web3</>,
            <>Screenshot its mindmap and upload up to {MINDMAP_PROMO.maxImages} images below</>,
          ].map((step, i) => (
            <li key={i} className="border-border bg-card flex gap-2.5 rounded-lg border p-3">
              <span className="text-foreground font-mono text-[12px]">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <section className="border-border bg-card mt-8 rounded-xl border p-4 sm:p-6">
          {!MINDMAP_PROMO.active ? (
            <p className="text-muted-foreground text-[14px]">
              This promo has ended. Thanks to everyone who took part.
            </p>
          ) : user ? (
            <PromoSubmissionForm submission={submission} />
          ) : (
            <div className="flex flex-col items-start gap-4">
              <p className="text-[14px]">Sign in to submit your mindmaps.</p>
              <div className="flex flex-wrap items-center gap-3">
                <ConnectWalletButton label="Connect wallet" />
                <Link
                  href="/signup"
                  className="text-muted-foreground hover:text-foreground text-[13px] underline-offset-4 hover:underline"
                >
                  Sign up with email
                </Link>
                <Link
                  href="/login"
                  className="text-muted-foreground hover:text-foreground text-[13px] underline-offset-4 hover:underline"
                >
                  Log in
                </Link>
              </div>
            </div>
          )}
        </section>

        <p className="text-label mt-6 text-[12px] leading-relaxed">
          One entry per account; submitting again replaces your entry. Screenshots
          are stored privately and only reviewed by the Doqtri team. Winners are
          contacted through the details you leave, or on X at @{MINDMAP_PROMO.xHandle}.
        </p>
      </main>
    </div>
  );
}
