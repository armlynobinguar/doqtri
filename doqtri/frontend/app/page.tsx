import { Geist, Geist_Mono } from "next/font/google";
import { LandingPage } from "@/components/landing/landing-page";

// The landing page predates the brand overhaul and keeps its original Geist
// type; the rest of the app uses Inter + JetBrains Mono from the root layout.
const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata = {
  title: "Doqtri — planned vs shipped, proven on-chain",
  description:
    "Living documents. Executable mindmaps. Tested vs shipped, block by block — anchored on Stellar.",
};

export default function Home() {
  return (
    <div
      className={`${geistSans.variable} ${geistMono.variable} font-sans`}
      // Pre-overhaul corner radius, which the shared Button derives from.
      style={{ "--radius": "0.375rem" } as React.CSSProperties}
    >
      <LandingPage />
    </div>
  );
}
