"use client";

import Link from "next/link";
import { Box, FileText, Link2, Network, type LucideIcon } from "lucide-react";
import { ConnectWalletButton } from "@/components/auth/connect-wallet-button";
import { EmailSignInLink } from "@/components/auth/email-sign-in-link";
import { BlockChain } from "@/components/brand/block-chain";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { BlockGlyph, type Glyph } from "@/components/brand/glyphs";
import { LandingMindmap } from "@/components/landing/landing-mindmap";
import { MINDMAP_PROMO, PROMO_PATH } from "@/lib/promo";
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

// The four-step loop, read left to right under the hero.
const LOOP: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: FileText, title: "Plan", body: "Turn ideas into structured documents." },
  { icon: Network, title: "Build", body: "Organize and connect your knowledge." },
  { icon: Box, title: "Ship", body: "Publish and execute." },
  { icon: Link2, title: "Verify", body: "Proven on-chain." },
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

      {MINDMAP_PROMO.active && (
        <Link href={PROMO_PATH} className={styles.announcement}>
          <span className={styles.announcementTag}>Beta launch</span>
          <span>
            Doqtri beta is live. Join and win from a {MINDMAP_PROMO.prizePool} prize pool!
          </span>
          <span className={styles.announcementCta}>How to join →</span>
        </Link>
      )}

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
          <Link href="/docs">Docs</Link>
        </nav>
        <div className={styles.navActions}>
          <EmailSignInLink size="sm" className={`${styles.cta} ${styles.navEmail}`} />
          <ConnectWalletButton size="sm" className={styles.cta} />
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero} id="top" aria-labelledby="brand">
          <div className={styles.heroCopy}>
            <p className={styles.heroTag}>Planned / Shipped / Proven on-chain</p>
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
              <EmailSignInLink size="lg" className={styles.cta} />
              <Link className={styles.secondary} href="/signup">
                Sign up with email
              </Link>
              <Link className={styles.secondary} href="/docs">
                Read the docs
              </Link>
            </div>
          </div>

          <figure className={styles.emblem}>
            <div className={styles.disc}>
              <DoqtriMark className={styles.emblemMark} />
              <BlockChain className={styles.discChain} animate={false} />
              <figcaption className={styles.tagline}>Tested vs Shipped, Block by Block.</figcaption>
            </div>
          </figure>
        </section>

        <ul className={styles.loop} aria-label="Plan, build, ship, verify">
          {LOOP.map(({ icon: Icon, title, body }) => (
            <li key={title}>
              <span className={`icon-tile ${styles.loopTile}`}>
                <Icon strokeWidth={1.5} />
              </span>
              <div>
                <strong>{title}</strong>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ul>

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
                <p>
                  Your Stellar testnet identity opens your private vault. Freighter and other Stellar wallets work —
                  or <Link href="/signup">sign up with email</Link> to start writing without one.
                </p>
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
          <div className={`${styles.proofCta} ${styles.actions}`}>
            <ConnectWalletButton size="lg" label="Open your vault" className={styles.cta} />
            <EmailSignInLink size="lg" className={styles.cta} />
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span className={styles.footerBrand}>
          <DoqtriMark className={styles.footerMark} glow={false} title="" />
          Doqtri
        </span>
        <span className={styles.footerLinks}>
          <Link href="/docs">Docs</Link>
          <a href={X_URL} target="_blank" rel="noreferrer">
            @usedoqtri
          </a>
          <span className={styles.footerMuted}>Stellar testnet · Soroban</span>
        </span>
      </footer>
    </div>
  );
}
