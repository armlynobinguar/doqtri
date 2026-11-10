import { Suspense } from "react";
import { LandingPage } from "@/components/landing/landing-page";
import { LandingTestimonials } from "@/components/landing/landing-testimonials";
import { legalPagesLive } from "@/lib/legal";
import { landingTestimonials } from "@/lib/referral-testimonials-store";

// Type comes from the root layout (Plus Jakarta Sans + JetBrains Mono), like
// the rest of the app.
export const metadata = {
  title: "Doqtri: planned vs shipped, proven on-chain",
  description:
    "Living documents. Executable mindmaps. Tested vs shipped, block by block, anchored on Stellar.",
};

/**
 * The landing page. Prerendered as before while the legal pages are off. Once
 * they're live, approved testimonials (DOQ-28) are read on every request and
 * streamed in under their own Suspense boundary, with no fallback: the rest of
 * the page never waits on the database, and a slow or failed read shows none.
 */
export default function Home() {
  return (
    <LandingPage
      legalLive={legalPagesLive()}
      testimonials={
        <Suspense fallback={null}>
          <Testimonials />
        </Suspense>
      }
    />
  );
}

async function Testimonials() {
  return <LandingTestimonials items={await landingTestimonials()} />;
}
