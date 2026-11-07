import { LandingPage } from "@/components/landing/landing-page";
import { landingTestimonials } from "@/lib/referral-testimonials-store";

// Type comes from the root layout (Plus Jakarta Sans + JetBrains Mono), like
// the rest of the app.
export const metadata = {
  title: "Doqtri: planned vs shipped, proven on-chain",
  description:
    "Living documents. Executable mindmaps. Tested vs shipped, block by block, anchored on Stellar.",
};

/**
 * The landing page. Prerendered as before while the legal pages are off; once
 * they're live it reads approved testimonials (DOQ-28) on every request, so a
 * withdrawal or an approval shows on the next load.
 */
export default async function Home() {
  return <LandingPage testimonials={await landingTestimonials()} />;
}
