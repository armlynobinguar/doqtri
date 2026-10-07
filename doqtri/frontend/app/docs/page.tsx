import type { Metadata } from "next";
import Link from "next/link";
import { ConnectWalletButton } from "@/components/auth/connect-wallet-button";
import { EmailSignInLink } from "@/components/auth/email-sign-in-link";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { BlockGlyph, type Glyph } from "@/components/brand/glyphs";
import { CONTRACT_ID, IS_MAINNET, labContractUrl } from "@/lib/stellar/config";
import styles from "./docs.module.css";

export const metadata: Metadata = {
  title: "Docs · Doqtri",
  description:
    "How Doqtri works: write living documents, compile them into executable mindmaps, and anchor versions and node status on Stellar.",
};

const REPO = "https://github.com/armlynobinguar/doqtri";
const NETWORK = IS_MAINNET ? "Mainnet" : "Testnet";

const TOC: [id: string, label: string][] = [
  ["overview", "Overview"],
  ["quick-start", "Quick start"],
  ["notes", "Writing notes"],
  ["import", "Importing documents"],
  ["mindmaps", "Mindmaps"],
  ["anchor", "Anchoring on Stellar"],
  ["nodes", "Node status"],
  ["audit", "Public audit"],
  ["security", "Security & privacy"],
  ["contract", "Contract reference"],
  ["faq", "FAQ"],
];

const NOTE_SNIPPET = `## Doc ingest
Import the spec and the pricing notes. See [[Pricing]].

## Mindmap

## Ship proof
### Audit page`;

// Brand status colors: neutral → blue → green → purple.
const LIFECYCLE: [label: string, tone: string | undefined][] = [
  ["Planned", undefined],
  ["Building", "building"],
  ["Built", "verified"],
  ["Verified", "onchain"],
];

const BLOCKS: { glyph: Glyph; title: string; body: string }[] = [
  { glyph: "check", title: "Tested", body: "Each mindmap node moves Planned → Building → Built → Verified." },
  { glyph: "hash", title: "Shipped", body: "Every semantic change is hashed (SHA-256) and bumps a version." },
  { glyph: "stellar", title: "Anchored", body: "Hashes and node status live in the DoqtriRegistry contract." },
];

export default function DocsPage() {
  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <Link href="/" className={styles.brand} aria-label="Doqtri home">
          <DoqtriMark className={styles.brandMark} glow={false} title="" />
          <span>Doqtri</span>
          <span className={styles.brandTag}>Docs</span>
        </Link>
        <nav className={styles.navLinks} aria-label="Site">
          <Link href="/">Home</Link>
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
        <div className={styles.navActions}>
          <EmailSignInLink size="sm" className={styles.cta} />
          <ConnectWalletButton size="sm" label="Open your vault" className={styles.cta} />
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.toc} aria-label="On this page">
          <p className={styles.tocTitle}>On this page</p>
          <ol>
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ol>
        </aside>

        <main className={styles.content}>
          <p className={styles.eyebrow}>Documentation</p>
          <h1 className={styles.title}>Doqtri docs</h1>
          <p className={styles.lede}>
            Living documents. Executable mindmaps. Planned vs shipped, proven on-chain. This guide covers everything
            from connecting a wallet to reading a document&rsquo;s record straight off the ledger.
          </p>

          <section id="overview" className={styles.section}>
            <h2>Overview</h2>
            <p>
              Teams plan in documents and ship somewhere else, so the doc says &ldquo;done&rdquo; long after reality
              moved on. Doqtri keeps the plan as markdown, compiles its headings into a mindmap whose nodes carry a
              build status, and anchors both on Stellar. Anyone can check what was planned and what shipped without
              trusting our database.
            </p>
            <ul className={styles.blocks}>
              {BLOCKS.map((b) => (
                <li key={b.title}>
                  <BlockGlyph glyph={b.glyph} className={styles.blockIcon} />
                  <strong>{b.title}</strong>
                  <span>{b.body}</span>
                </li>
              ))}
            </ul>
          </section>

          <section id="quick-start" className={styles.section}>
            <h2>Quick start</h2>
            <ol className={styles.steps}>
              <li>
                <strong>Install a Stellar wallet.</strong> <a href="https://www.freighter.app/" target="_blank" rel="noreferrer">Freighter</a>{" "}
                works best; xBull, Lobstr, Hana, Klever, OneKey and HOT are also supported. Switch it to{" "}
                <b>Stellar {NETWORK}</b>.
              </li>
              <li>
                <strong>Connect.</strong> Click <b>Connect wallet</b> and pick your wallet. It then asks you to approve a{" "}
                <b>sign-in message</b> — this proves you own the account. It is not a transaction and costs nothing.
              </li>
              <li>
                <strong>Open your vault.</strong> Your notes, graph and mindmaps are private to your wallet.
              </li>
              {!IS_MAINNET && (
                <li>
                  <strong>Fund the account.</strong> Anchoring sends real (test) transactions, so the account needs XLM.
                  On testnet, use <b>Fund with Friendbot</b> in the ship panel; the account menu shows your balance.
                </li>
              )}
            </ol>
          </section>

          <section id="notes" className={styles.section}>
            <h2>Writing notes</h2>
            <p>Notes are markdown, and markdown is the source of truth — everything else is derived from it.</p>
            <ul className={styles.list}>
              <li>
                Headings (<code>#</code> to <code>######</code>) become <b>mindmap nodes</b>, nested by level under
                the note&rsquo;s title.
              </li>
              <li>
                <code>[[Another note]]</code> links notes. Links build the <b>global graph</b> and each note&rsquo;s
                backlinks.
              </li>
              <li>Edits save automatically. The mindmap and hash are recomputed from the text, so nothing goes stale.</li>
            </ul>
            <pre className={styles.code}>
              <code>
                {NOTE_SNIPPET.split("\n").map((line, i) => (
                  <span key={i} className={styles.line}>
                    {line}
                    {"\n"}
                  </span>
                ))}
              </code>
            </pre>
          </section>

          <section id="import" className={styles.section}>
            <h2>Importing documents</h2>
            <p>
              <b>Upload document</b> turns a PDF, DOCX, PPTX or text file (up to 20&nbsp;MB) into a note. The import
              runs in stages and shows each one as it happens:
            </p>
            <ol className={styles.pipeline}>
              <li>Upload — the original is archived privately first</li>
              <li>Extract — text and tables are pulled out</li>
              <li>Format — an AI pass adds headings and [[wikilinks]]</li>
              <li>Save — the note appears in your vault</li>
              <li>Mindmap — generated from the new headings</li>
            </ol>
            <p>If a stage fails, the import can be retried from the archived original without uploading again.</p>
          </section>

          <section id="mindmaps" className={styles.section}>
            <h2>Mindmaps</h2>
            <ul className={styles.list}>
              <li>
                <b>Note mindmap</b> — in a note&rsquo;s Mindmap tab. Use <b>Build mindmap</b> (or <b>Rebuild</b>) and{" "}
                <b>Open full mindmap</b> for a full-screen view.
              </li>
              <li>
                <b>Global mindmap</b> — every note and the links between them, from the ribbon.
              </li>
              <li>Node ids are positional (<code>h0</code>, <code>h1</code>, …), which is what the contract stores.</li>
            </ul>
          </section>

          <section id="anchor" className={styles.section}>
            <h2>Anchoring on Stellar</h2>
            <p>
              The ship panel anchors a note: it computes the SHA-256 of the note&rsquo;s markdown and records it in the
              DoqtriRegistry contract, signed by your wallet.
            </p>
            <ul className={styles.list}>
              <li>
                <b>Save &amp; anchor</b> — saves the note, then anchors exactly what was saved. The first anchor
                creates version <code>1</code> with you as owner; each later one anchors the new hash as the next
                version. It stays disabled while the note matches its latest anchor.
              </li>
              <li>
                Only the hash goes on-chain — never the note&rsquo;s text. Earlier versions stay in the ledger&rsquo;s
                history.
              </li>
            </ul>
          </section>

          <section id="nodes" className={styles.section}>
            <h2>Node status</h2>
            <div className={styles.lifecycle} aria-label="Node lifecycle">
              {LIFECYCLE.map(([s, tone], i) => (
                <span key={s}>
                  {i > 0 && <span className={styles.arrow} aria-hidden>→</span>}
                  <span className={styles.pill} data-tone={tone}>
                    {s}
                  </span>
                </span>
              ))}
            </div>
            <p>
              For each node, the ship panel records a status, the tool that built it (n8n, Make, Retool, Langflow, …)
              and an artifact reference such as a workflow id. Status is tied to a version: if the note changed since it
              was anchored, update the hash first so the status describes the right plan.
            </p>
          </section>

          <section id="audit" className={styles.section}>
            <h2>Public audit</h2>
            <p>
              Every anchored document has a public page at <code>/d/&lt;docId&gt;</code> — no login needed. It reads
              the contract directly: current version, hash, owner, the version history, and each node&rsquo;s status.
            </p>
            <ul className={styles.list}>
              <li>
                <b>Show headings on public page</b> (ship panel) adds node labels, but only while your private note is
                byte-identical to the anchored version.
              </li>
              <li>
                <b>Hash check</b> — paste text or drop a file on the audit page to compare its SHA-256 with the anchored
                hash. It runs in your browser; nothing is uploaded.
              </li>
            </ul>
          </section>

          <section id="security" className={styles.section}>
            <h2>Security &amp; privacy</h2>
            <ul className={styles.list}>
              <li>
                <b>Sign-in needs your signature.</b> Knowing a wallet address isn&rsquo;t enough: the wallet must sign a
                one-time, five-minute sign-in message.
              </li>
              <li>
                <b>Notes are private.</b> Row-level security limits every note and import to its owner; uploads sit in
                a private storage bucket.
              </li>
              <li>
                <b>On-chain data is minimal and permanent.</b> Only hashes, node ids, statuses, tool names and artifact
                references are written. Anything anchored can&rsquo;t be deleted from the ledger.
              </li>
              <li>
                <b>Every write is yours.</b> The contract requires the document owner&rsquo;s signature for each change.
              </li>
            </ul>
          </section>

          <section id="contract" className={styles.section}>
            <h2>Contract reference</h2>
            <p>
              DoqtriRegistry on Stellar {NETWORK}:{" "}
              <a href={labContractUrl()} target="_blank" rel="noreferrer" className={styles.mono}>
                {CONTRACT_ID}
              </a>
            </p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Function</th>
                    <th>Auth</th>
                    <th>What it does</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>register_document(owner, doc_id, content_hash)</code></td>
                    <td>owner</td>
                    <td>Anchor a new document at version 1</td>
                  </tr>
                  <tr>
                    <td><code>update_document(doc_id, new_hash)</code></td>
                    <td>owner</td>
                    <td>Anchor a new hash; returns the next version</td>
                  </tr>
                  <tr>
                    <td><code>set_node_status(doc_id, node_id, status, tool, artifact_ref)</code></td>
                    <td>owner</td>
                    <td>Record a node&rsquo;s lifecycle step</td>
                  </tr>
                  <tr>
                    <td><code>get_document(doc_id)</code></td>
                    <td>—</td>
                    <td>Read a document&rsquo;s anchored state</td>
                  </tr>
                  <tr>
                    <td><code>get_node(doc_id, node_id)</code></td>
                    <td>—</td>
                    <td>Read a node&rsquo;s build record</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className={styles.note}>
              Events: <code>(doqtri, register)</code>, <code>(doqtri, update)</code>, <code>(doqtri, node)</code>, each
              carrying the <code>doc_id</code>. Architecture diagrams are in the{" "}
              <a href={`${REPO}#architecture`} target="_blank" rel="noreferrer">README</a>.
            </p>
          </section>

          <section id="faq" className={styles.section}>
            <h2>FAQ</h2>
            <dl className={styles.faq}>
              <dt>Does signing in cost anything?</dt>
              <dd>No. The sign-in message is not a transaction. Only anchoring and node updates are transactions.</dd>
              <dt>My wallet says it can&rsquo;t sign messages.</dt>
              <dd>Albedo and Rabet don&rsquo;t support message signing yet. Use Freighter or another supported wallet.</dd>
              <dt>Can I delete an anchored version?</dt>
              <dd>
                You can delete the note from your vault, but the hash and statuses already on the ledger stay there —
                that permanence is what makes them proof.
              </dd>
              <dt>Why does the public page show node ids instead of headings?</dt>
              <dd>
                Headings are private unless you turn on <b>Show headings on public page</b> and the note matches the
                anchored version exactly.
              </dd>
            </dl>
          </section>

          <div className={styles.footerCta}>
            <DoqtriMark className={styles.footerMark} />
            <p>Tested vs Shipped, Block by Block.</p>
            <div className={styles.navActions}>
              <ConnectWalletButton size="lg" label="Open your vault" className={styles.cta} />
              <EmailSignInLink size="lg" className={styles.cta} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
