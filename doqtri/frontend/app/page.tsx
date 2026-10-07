import { LandingPage } from "@/components/landing/landing-page";

// Type comes from the root layout (Plus Jakarta Sans + JetBrains Mono), like
// the rest of the app.
export const metadata = {
  title: "Doqtri — planned vs shipped, proven on-chain",
  description:
    "Living documents. Executable mindmaps. Tested vs shipped, block by block — anchored on Stellar.",
};

export default function Home() {
  return <LandingPage />;
}
