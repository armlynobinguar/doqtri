"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Coins, FileText, Link2, UserPlus, type LucideIcon } from "lucide-react";
import type { SiteStats } from "@/lib/site-stats";
import styles from "./landing-page.module.css";

/** How often an open, visible landing page refreshes its numbers. */
const POLL_MS = 30_000;
/** How long a number takes to count up to a new value. */
const COUNT_MS = 1100;

const fmt = new Intl.NumberFormat("en-US");
/** Fees are fractions of an XLM; four significant digits keep them readable. */
const fmtXlm = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });

/** Each card's accent, one of the brand tints. */
type Tone = "purple" | "blue" | "green" | "pearl";

/**
 * Counts from the last shown value to `value` with an ease-out, so a fresh
 * load or a poll that brings new sign-ups visibly ticks up. Screen readers get
 * the final number only; reduced-motion users get it straight away.
 */
function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / COUNT_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = origin + (value - origin) * eased;
      from.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <>
      <span aria-hidden>{format(shown)}</span>
      <span className="sr-only">{format(value)}</span>
    </>
  );
}

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

  const items: {
    icon: LucideIcon;
    tone: Tone;
    label: string;
    value: number;
    format: (n: number) => string;
    unit?: string;
    note?: string;
  }[] = [
    { icon: UserPlus, tone: "purple", label: "Sign-ups", value: stats.users, format: (n) => fmt.format(Math.round(n)) },
    { icon: FileText, tone: "blue", label: "Documents created", value: stats.documents, format: (n) => fmt.format(Math.round(n)) },
    { icon: Link2, tone: "green", label: "Testnet transactions", value: stats.transactions, format: (n) => fmt.format(Math.round(n)) },
    ...(stats.fee
      ? [
          {
            icon: Coins,
            tone: "pearl" as const,
            label: "Avg. fee per transaction",
            value: stats.fee.avgXlm,
            format: (n: number) => fmtXlm.format(n),
            unit: "XLM",
            note:
              stats.fee.sample === 1
                ? "Measured from the latest anchor write on testnet"
                : `Measured from the last ${stats.fee.sample} anchor writes on testnet`,
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
        {items.map(({ icon: Icon, tone, label, value, format, unit, note }) => (
          <div key={label} className={styles.statCard} style={{ "--tone": `var(--brand-${tone})` } as CSSProperties}>
            <dt>
              <span className={`icon-tile ${styles.statIcon}`} aria-hidden>
                <Icon strokeWidth={1.5} />
              </span>
              {label}
            </dt>
            <dd>
              <span className={styles.statValue}>
                <CountUp value={value} format={format} />
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
