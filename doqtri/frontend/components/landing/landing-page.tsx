"use client";

import { ConnectWalletButton } from "@/components/auth/connect-wallet-button";
import { LandingMindmap } from "@/components/landing/landing-mindmap";
import styles from "./landing-page.module.css";

export function LandingPage() {
  return (
    <div className={styles.page}>
      <div className={styles.atmosphere} aria-hidden />

      <header className={styles.nav}>
        <a href="#top" className={styles.navBrand}>
          Doqtri
        </a>
        <nav className={styles.navLinks} aria-label="Primary">
          <a href="#map">Map</a>
          <a href="#how">How</a>
          <a href="#proof">Proof</a>
        </nav>
        <ConnectWalletButton size="sm" />
      </header>

      <main>
        <section className={styles.hero} id="top" aria-labelledby="brand">
          <div className={styles.heroCopy}>
            <h1 id="brand" className={styles.brand}>
              Doqtri
            </h1>
            <p className={styles.headline}>Your last next plan.</p>
            <p className={styles.support}>
              Living documents become executable mindmaps. Anchor every version
              and node status on Stellar — planned vs shipped, ledger-true.
            </p>
            <div className={styles.actions}>
              <ConnectWalletButton size="lg" />
              <a className={styles.secondary} href="#map">
                See the map
              </a>
            </div>
          </div>
          <LandingMindmap />
        </section>

        <section className={styles.mapBand} id="map" aria-labelledby="map-title">
          <div className={styles.bandInner}>
            <h2 id="map-title" className={styles.bandTitle}>
              From headings to a live map
            </h2>
            <p className={styles.bandSupport}>
              Markdown is the source of truth. Wikilinks become the global graph;
              headings become the mindmap. Nothing second-hand to go stale.
            </p>
          </div>
        </section>

        <section className={styles.how} id="how" aria-labelledby="how-title">
          <h2 id="how-title" className={styles.howTitle}>
            How it works
          </h2>
          <p className={styles.howSupport}>
            One wallet. One vault. On-chain receipts when you ship.
          </p>
          <ol className={styles.steps}>
            <li>
              <span className={styles.stepNum}>01</span>
              <div>
                <strong>Connect wallet</strong>
                <p>Stellar testnet identity opens your private vault.</p>
              </div>
            </li>
            <li>
              <span className={styles.stepNum}>02</span>
              <div>
                <strong>Write or ingest</strong>
                <p>
                  New notes work like Obsidian — headings become the mindmap;
                  uploads convert PDFs and docs the same way.
                </p>
              </div>
            </li>
            <li>
              <span className={styles.stepNum}>03</span>
              <div>
                <strong>Anchor & ship</strong>
                <p>
                  Register the content hash and node statuses on DoqtriRegistry
                  (Soroban).
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section className={styles.proof} id="proof" aria-labelledby="proof-title">
          <h2 id="proof-title" className={styles.howTitle}>
            Planned → Verified
          </h2>
          <p className={styles.howSupport}>
            Each mindmap node carries a lifecycle on-chain — not a slide deck
            claim.
          </p>
          <ul className={styles.lifecycle}>
            <li>Planned</li>
            <li>Building</li>
            <li>Built</li>
            <li>Verified</li>
          </ul>
          <div className={styles.proofCta}>
            <ConnectWalletButton size="lg" label="Open vault" />
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>Doqtri</span>
        <span className={styles.footerMuted}>Stellar · Soroban · Supabase</span>
      </footer>
    </div>
  );
}
