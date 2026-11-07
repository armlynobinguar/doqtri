import Link from "next/link";
import type { ReactNode } from "react";
import { OpenVaultLink } from "@/components/auth/open-vault-link";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { LEGAL_LAST_UPDATED } from "@/lib/legal-copy";
import styles from "@/app/docs/docs.module.css";

export type LegalSection = { id: string; title: string; body: ReactNode };

/** One legal document, in the docs page's layout: nav, table of contents, sections. */
export function LegalPage({
  tag,
  title,
  lede,
  sections,
  other,
}: {
  tag: string;
  title: string;
  lede: ReactNode;
  sections: LegalSection[];
  /** The other legal document, linked at the foot. */
  other: { href: string; label: string };
}) {
  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <Link href="/" className={styles.brand} aria-label="Doqtri home">
          <DoqtriMark className={styles.brandMark} glow={false} title="" />
          <span>Doqtri</span>
          <span className={styles.brandTag}>{tag}</span>
        </Link>
        <nav className={styles.navLinks} aria-label="Site">
          <Link href="/">Home</Link>
          <Link href="/docs">Docs</Link>
          <Link href={other.href}>{other.label}</Link>
        </nav>
        <div className={styles.navActions}>
          <OpenVaultLink size="sm" className={styles.cta} />
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.toc} aria-label="On this page">
          <p className={styles.tocTitle}>On this page</p>
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </aside>

        <main className={styles.content}>
          <p className={styles.eyebrow}>Legal</p>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.lede}>{lede}</p>
          <p className={styles.note}>Last updated {LEGAL_LAST_UPDATED}</p>

          {sections.map((s) => (
            <section key={s.id} id={s.id} className={styles.section}>
              <h2>{s.title}</h2>
              {s.body}
            </section>
          ))}

          <section className={styles.section}>
            <p>
              See also the <Link href={other.href}>{other.label}</Link>.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}

/** A table in the docs style, scrolling inside its own box on phones. */
export function LegalTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LegalList({ items }: { items: ReactNode[] }) {
  return (
    <ul className={styles.list}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

export function MailLink({ address }: { address: string }) {
  return <a href={`mailto:${address}`}>{address}</a>;
}
