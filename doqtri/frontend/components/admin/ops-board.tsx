"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { OpsChannelsSection } from "@/components/admin/ops-channels";
import { OPS_TONE } from "@/components/admin/ops-tone";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import type { OpsCheck, OpsReport, OpsSection, OpsStatus } from "@/lib/ops/types";
import { cn } from "@/lib/utils";

/** How often the board asks again. */
export const REFRESH_MS = 60_000;

const SECTIONS: { id: OpsSection; title: string; blurb: string }[] = [
  { id: "spendable", title: "Spendable", blurb: "Balances, quotas, TTLs and sizes that run out." },
  { id: "statuses", title: "Statuses", blurb: "Queues and backlogs, from one database read." },
  { id: "health", title: "Health", blurb: "Scheduled runs, dependencies and configuration." },
];

export type BillingLink = { label: string; href: string };

function counts(checks: OpsCheck[]): Partial<Record<OpsStatus, number>> {
  const out: Partial<Record<OpsStatus, number>> = {};
  for (const check of checks) out[check.status] = (out[check.status] ?? 0) + 1;
  return out;
}

function Tally({ checks }: { checks: OpsCheck[] }) {
  const c = counts(checks);
  const order: OpsStatus[] = ["crit", "unknown", "warn", "ok", "off"];
  return (
    <div className="flex flex-wrap gap-1.5">
      {order
        .filter((status) => c[status])
        .map((status) => (
          <StatusTag key={status} tone={OPS_TONE[status]}>
            {c[status]} {status}
          </StatusTag>
        ))}
    </div>
  );
}

function CheckRow({ check }: { check: OpsCheck }) {
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border border-[var(--glass-lo)] bg-[var(--glass)] px-4 py-3",
        check.status === "off" && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[14px] font-medium">{check.label}</span>
        <StatusTag tone={OPS_TONE[check.status]}>{check.status}</StatusTag>
      </div>
      <div className="font-mono text-[15px] tabular-nums">{check.value}</div>
      {check.detail && <p className="text-muted-foreground text-[12.5px] leading-snug break-words">{check.detail}</p>}
      {check.threshold && <p className="text-muted-foreground/80 text-[11.5px] leading-snug">{check.threshold}</p>}
    </li>
  );
}

/** The ops report, worst first per section, asked again every minute and on demand. */
export function OpsBoard({ initial, billing }: { initial: OpsReport; billing: BillingLink[] }) {
  const [report, setReport] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/ops", { cache: "no-store" });
      if (!res.ok) throw new Error(`The report answered HTTP ${res.status}`);
      setReport((await res.json()) as OpsReport);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // UTC, so the server's render and the browser's agree (no hydration mismatch).
  const generated = `${report.generatedAt.slice(11, 19)} UTC`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-[13px]">
            <code className="font-mono">{report.environment}</code> · network{" "}
            <code className="font-mono">{report.network}</code>
            {report.commit && (
              <>
                {" "}
                · commit <code className="font-mono">{report.commit}</code>
              </>
            )}{" "}
            · read {generated}
          </p>
          <Tally checks={report.checks} />
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
          {loading ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-destructive text-[13px]">
          {error}. Showing the report from {generated}.
        </p>
      )}

      {SECTIONS.map((section) => {
        const checks = report.checks.filter((check) => check.section === section.id);
        return (
          <section key={section.id} aria-labelledby={`ops-${section.id}`} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 id={`ops-${section.id}`} className="text-xl font-semibold tracking-tight">
                  {section.title}
                </h2>
                <p className="text-muted-foreground text-[13px]">{section.blurb}</p>
              </div>
              <Tally checks={checks} />
            </div>
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          </section>
        );
      }).flatMap((node, i) =>
        // The per-channel table sits right under Spendable, where its summary check is.
        SECTIONS[i].id === "spendable" ? [node, <OpsChannelsSection key="channels" channels={report.channels} />] : [node],
      )}

      <section aria-labelledby="ops-billing" className="flex flex-col gap-3">
        <div>
          <h2 id="ops-billing" className="text-xl font-semibold tracking-tight">
            Billing
          </h2>
          <p className="text-muted-foreground text-[13px]">
            Not readable from the app; open each provider&apos;s usage page.
          </p>
        </div>
        <ul className="flex flex-wrap gap-2">
          {billing.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--glass-lo)] bg-[var(--glass)] px-3 py-1.5 text-[13px] hover:border-[var(--glass-hi)]"
              >
                {link.label}
                <ExternalLinkIcon className="size-3.5" />
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
