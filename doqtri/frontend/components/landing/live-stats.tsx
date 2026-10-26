"use client";

import { useEffect, useState } from "react";
import type { SiteStats } from "@/lib/site-stats";
import styles from "./landing-page.module.css";

/** How often an open, visible landing page refreshes its numbers. */
const POLL_MS = 30_000;

const fmt = new Intl.NumberFormat("en-US");

/**
 * Live sign-ups, documents, and testnet contract transactions. Polls
 * /api/stats while the tab is visible and refreshes as soon as it comes back.
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

  const items = [
    { label: "Sign-ups", value: stats.users },
    { label: "Documents created", value: stats.documents },
    { label: "Testnet contract transactions", value: stats.transactions },
  ];

  return (
    <section className={styles.stats} aria-labelledby="stats-title">
      <p id="stats-title" className={styles.eyebrow}>
        <span className={styles.liveDot} aria-hidden /> Live on Doqtri
      </p>
      <dl className={styles.statGrid}>
        {items.map((s) => (
          <div key={s.label} className={styles.statCard}>
            <dt>{s.label}</dt>
            <dd>{fmt.format(s.value)}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.statSource}>
        On-chain activity from stellar.expert:{" "}
        {stats.contracts.map((c, i) => (
          <span key={c.id}>
            {i > 0 && " · "}
            <a href={c.url} target="_blank" rel="noreferrer">
              {c.label} ({fmt.format(c.invocations)})
            </a>
          </span>
        ))}
      </p>
    </section>
  );
}
