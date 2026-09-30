"use client";

import { ConnectWalletButton } from "@/components/auth/connect-wallet-button";
import { BlockChain } from "@/components/brand/block-chain";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { BlockGlyph, type Glyph } from "@/components/brand/glyphs";
import { LandingMindmap } from "@/components/landing/landing-mindmap";
import styles from "./landing-page.module.css";

const X_URL = "https://x.com/usedoqtri";

const BLOCKS: { glyph: Glyph; title: string; body: string }[] = [
  {
    glyph: "check",
    title: "Tested",
    body: "Every mindmap node carries a lifecycle — Planned, Building, Built, Verified — so “done” means checked, not claimed.",
  },
  {
    glyph: "hash",
    title: "Shipped",
    body: "Each semantic change to a plan is hashed with SHA-256 and bumps a version. Shipped nodes keep the builder and artifact they went live with.",
  },
  {
    glyph: "stellar",
    title: "Anchored on Stellar",
    body: "Hashes and node status land in the DoqtriRegistry contract on Soroban, signed by your wallet. The ledger is the receipt.",
  },
];

const LIFECYCLE: { label: string; glyph: Glyph }[] = [
  { label: "Planned", glyph: "check" },
  { label: "Building", glyph: "hash" },
  { label: "Built", glyph: "hash" },
  { label: "Verified", glyph: "stellar" },
];

export function LandingPage() {
  return (
    <div className={styles.page}>
      <div className={styles.atmosphere} aria-hidden />

      <header className={styles.nav}>
        <a href="#top" className={styles.navBrand} aria-label="Doqtri home">
          <DoqtriMark className={styles.navMark} glow={false} title="" />
          <span>Doqtri</span>
        </a>
        <nav className={styles.navLinks} aria-label="Primary">
          <a href="#blocks">Blocks</a>
          <a href="#map">Map</a>
          <a href="#how">How</a>
          <a href="#proof">Proof</a>
        </nav>
        <ConnectWalletButton size="sm" className={styles.cta} />
      </header>

      <main className={styles.main}>
        <section className={styles.hero} id="top" aria-labelledby="brand">
          <div className={styles.heroCopy}>
            <BlockChain className={styles.heroChain} />
            <h1 id="brand" className={styles.brand}>
              Doqtri
            </h1>
            <p className={styles.headline}>Planned vs shipped, proven on-chain.</p>
            <p className={styles.support}>
              Living documents. Executable mindmaps. Built on Stellar — every
              version and every shipped node gets a ledger-true receipt.
            </p>
            <div className={styles.actions}>
              <ConnectWalletButton size="lg" label="Open your vault" className={styles.cta} />
              <a className={styles.secondary} href="#how">
                How it works
              </a>
            </div>
          </div>

          <figure className={styles.emblem}>
            <div className={styles.disc}>
              <DoqtriMark className={styles.emblemMark} />
              <figcaption className={styles.tagline}>Tested vs Shipped, Block by Block.</figcaption>
            </div>
          </figure>
        </section>

        <section className={styles.blocks} id="blocks" aria-labelledby="blocks-title">
          <p className={styles.eyebrow}>Three blocks</p>
          <h2 id="blocks-title" className={styles.sectionTitle}>
            Every plan, reduced to what you can prove
          </h2>
          <ul className={styles.blockGrid}>
            {BLOCKS.map((b) => (
              <li key={b.title} className={styles.blockCard}>
                <BlockGlyph glyph={b.glyph} className={styles.blockIcon} />
                <h3>{b.title}</h3>
                <p>{b.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.mapBand} id="map" aria-labelledby="map-title">
          <div className={styles.mapCopy}>
            <p className={styles.eyebrow}>Executable mindmaps</p>
            <h2 id="map-title" className={styles.sectionTitle}>
              From headings to a live map
            </h2>
            <p className={styles.sectionSupport}>
              Markdown is the source of truth. <code>##</code> headings compile into the mindmap and wikilinks
              into the global graph — nothing second-hand to go stale.
            </p>
          </div>
          <LandingMindmap />
        </section>

        <section className={styles.how} id="how" aria-labelledby="how-title">
          <p className={styles.eyebrow}>How it works</p>
          <h2 id="how-title" className={styles.sectionTitle}>
            One wallet. One vault. A receipt when you ship.
          </h2>
          <ol className={styles.steps}>
            <li>
              <BlockGlyph glyph="check" className={styles.stepIcon} />
              <div>
                <strong>Connect a Stellar wallet</strong>
                <p>Your Stellar testnet identity opens your private vault. Freighter and other Stellar wallets work.</p>
              </div>
            </li>
            <li>
              <BlockGlyph glyph="hash" className={styles.stepIcon} />
              <div>
                <strong>Write or ingest</strong>
                <p>Notes work like Obsidian. Upload PDFs and docs and they convert the same way — headings become the map.</p>
              </div>
            </li>
            <li>
              <BlockGlyph glyph="stellar" className={styles.stepIcon} />
              <div>
                <strong>Anchor &amp; ship</strong>
                <p>Register the content hash and node statuses on DoqtriRegistry. Attach the n8n, Make, Retool or Langflow build that shipped it.</p>
              </div>
            </li>
          </ol>
        </section>

        <section className={styles.proof} id="proof" aria-labelledby="proof-title">
          <p className={styles.eyebrow}>Block by block</p>
          <h2 id="proof-title" className={styles.sectionTitle}>
            Planned → Verified, on the ledger
          </h2>
          <ol className={styles.lifecycle} aria-label="Node lifecycle">
            {LIFECYCLE.map((s, i) => (
              <li key={s.label}>
                {i > 0 && <span className={styles.lifecycleLink} aria-hidden />}
                <span className={styles.lifecycleStep}>
                  <BlockGlyph glyph={s.glyph} className={styles.lifecycleIcon} />
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
          <p className={styles.sectionSupport}>
            Anyone can open a document&rsquo;s public audit page and read its version history and node status straight
            from the contract — not from our database.
          </p>
          <div className={styles.proofCta}>
            <ConnectWalletButton size="lg" label="Open your vault" className={styles.cta} />
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span className={styles.footerBrand}>
          <DoqtriMark className={styles.footerMark} glow={false} title="" />
          Doqtri
        </span>
        <span className={styles.footerLinks}>
          <a href={X_URL} target="_blank" rel="noreferrer">
            @usedoqtri
          </a>
          <span className={styles.footerMuted}>Stellar testnet · Soroban</span>
        </span>
      </footer>
    </div>
  );
}
