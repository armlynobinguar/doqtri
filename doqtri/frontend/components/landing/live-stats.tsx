"use client";

import { useEffect, useState } from "react";
import { Coins, FileText, Link2, UserPlus, type LucideIcon } from "lucide-react";
import type { SiteStats } from "@/lib/site-stats";
import styles from "./landing-page.module.css";

/** How often an open, visible landing page refreshes its numbers. */
const POLL_MS = 30_000;

const fmt = new Intl.NumberFormat("en-US");
/** Fees are fractions of an XLM; four significant digits keep them readable. */
const fmtXlm = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });

/**
 * Live sign-ups, documents, testnet contract transactions, and what a
 * transaction really costs. Polls /api/stats while the tab is visible and
 * refreshes as soon as it comes back.
 * Renders nothing until the first read lands, so a failed read never shows
 * zeros as if they were real.
 */
export function LiveStats() {
  const [stats, setStats] = useState<SiteStats | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/stats");
        if (res.ok && alive) setStats((await res.json()) as SiteStats);
      } catch {
        // Keep the last numbers on a network blip; the next poll retries.
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  if (!stats) return null;

  const items: { icon: LucideIcon; label: string; value: string; unit?: string; note?: string }[] = [
    { icon: UserPlus, label: "Sign-ups", value: fmt.format(stats.users) },
    { icon: FileText, label: "Documents created", value: fmt.format(stats.documents) },
    { icon: Link2, label: "Testnet contract transactions", value: fmt.format(stats.transactions) },
    ...(stats.fee
      ? [
          {
            icon: Coins,
            label: "Avg. fee per transaction",
            value: fmtXlm.format(stats.fee.avgXlm),
            unit: "XLM",
            note: `Measured from the last ${stats.fee.sample} anchor writes on testnet`,
          },
        ]
      : []),
  ];

  return (
    <section className={styles.stats} aria-labelledby="stats-title">
      <p id="stats-title" className={styles.eyebrow}>
        <span className={styles.liveDot} aria-hidden /> Live on Doqtri
      </p>
      <dl className={styles.statGrid}>
        {items.map(({ icon: Icon, label, value, unit, note }) => (
          <div key={label} className={styles.statCard}>
            <dt>
              <span className={`icon-tile ${styles.statIcon}`} aria-hidden>
                <Icon strokeWidth={1.5} />
              </span>
              {label}
            </dt>
            <dd>
              <span className={styles.statValue}>
                {value}
                {unit && <span className={styles.statUnit}> {unit}</span>}
              </span>
              {note && <span className={styles.statNote}>{note}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
