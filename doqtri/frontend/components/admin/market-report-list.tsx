"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EyeIcon, EyeOffIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import { shortAddress } from "@/lib/market";
import type { ReportedTemplate, ReportItem } from "@/lib/market-server";
import { cn } from "@/lib/utils";

type Filter = ReportItem["status"] | "all";

const STATUS_TONE: Record<ReportItem["status"], "warning" | "danger" | "planned"> = {
  open: "warning",
  upheld: "danger",
  dismissed: "planned",
};

const FILTERS: Filter[] = ["open", "upheld", "dismissed", "all"];

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatChainTime(seconds: number | null) {
  return seconds === null ? "unknown" : new Date(seconds * 1000).toLocaleString();
}

async function send(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Update failed (${res.status})`);
  }
}

/** Review list for copy reports: both sides, the evidence, and the decision. */
export function MarketReportList({ reports }: { reports: ReportItem[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("open");
  const [saving, setSaving] = useState<string | null>(null);

  const shown = filter === "all" ? reports : reports.filter((r) => r.status === filter);
  const count = (f: Filter) => (f === "all" ? reports.length : reports.filter((r) => r.status === f).length);

  async function act(key: string, url: string, body: unknown, done: string) {
    setSaving(key);
    try {
      await send(url, body);
      toast.success(done);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed");
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <div className="mt-6 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter reports">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px] capitalize transition-colors",
              filter === f
                ? "text-foreground border-[var(--glass-hi)] bg-[var(--glass-strong)] shadow-[inset_0_1px_0_0_var(--glass-hi)]"
                : "text-muted-foreground border-[var(--glass-lo)] hover:text-foreground",
            )}
          >
            {f} <span className="text-label">{count(f)}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-muted-foreground mt-10 text-center text-[14px]">
          {reports.length === 0 ? "No reports yet." : "Nothing in this filter."}
        </p>
      ) : (
        <ul className="mt-5 grid gap-4">
          {shown.map((r) => {
            const busy = saving !== null;
            return (
              <li key={r.id} className="glass rounded-2xl p-5" data-testid={`report-${r.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-label text-[11px]">Reported {formatDate(r.createdAt)}</p>
                    <p className="text-foreground mt-1 text-[13px] whitespace-pre-wrap">
                      {r.reason || <span className="text-muted-foreground">No reason given.</span>}
                    </p>
                  </div>
                  <StatusTag tone={STATUS_TONE[r.status]} className="capitalize">
                    {r.status}
                  </StatusTag>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                  {r.sameHash ? <StatusTag tone="danger">Same content hash</StatusTag> : null}
                  <StatusTag tone={r.similarity >= 0.6 ? "warning" : "planned"}>
                    {Math.round(r.similarity * 100)}% of headings shared
                  </StatusTag>
                  <StatusTag tone="onchain">
                    Listed first: {r.earlier === "unknown" ? "unknown" : r.earlier === "original" ? "original" : "reported"}
                  </StatusTag>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <Side
                    label="Reported"
                    side={r.reported}
                    first={r.earlier === "reported"}
                    busy={busy}
                    onToggle={() =>
                      void act(
                        `${r.id}-reported`,
                        `/api/admin/market/templates/${r.reported.id}`,
                        { hidden: !r.reported.hidden },
                        r.reported.hidden ? "Template unhidden" : "Template hidden",
                      )
                    }
                  />
                  <Side
                    label="Original"
                    side={r.original}
                    first={r.earlier === "original"}
                    busy={busy}
                    onToggle={() =>
                      void act(
                        `${r.id}-original`,
                        `/api/admin/market/templates/${r.original.id}`,
                        { hidden: !r.original.hidden },
                        r.original.hidden ? "Template unhidden" : "Template hidden",
                      )
                    }
                  />
                </div>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {r.status === "open" ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() =>
                          void act(r.id, `/api/admin/market/reports/${r.id}`, { action: "uphold" }, "Upheld: copy hidden")
                        }
                      >
                        <EyeOffIcon />
                        Uphold and hide copy
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act(r.id, `/api/admin/market/reports/${r.id}`, { action: "dismiss" }, "Dismissed")}
                      >
                        <XIcon />
                        Dismiss
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(r.id, `/api/admin/market/reports/${r.id}`, { action: "reopen" }, "Reopened")}
                    >
                      <RotateCcwIcon />
                      Reopen
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Side({
  label,
  side,
  first,
  busy,
  onToggle,
}: {
  label: string;
  side: ReportedTemplate;
  first: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="rounded-xl border border-[var(--glass-lo)] bg-[var(--glass)] p-3 text-[12px]" aria-label={label}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="eyebrow text-label text-[10px]">
            {label}
            {first ? " · listed first" : ""}
          </p>
          <p className="text-foreground mt-0.5 truncate text-[13px] font-semibold">{side.title}</p>
        </div>
        {side.hidden ? <StatusTag tone="danger">Hidden</StatusTag> : null}
      </div>
      <dl className="text-muted-foreground mt-2 grid gap-0.5">
        <div className="flex gap-2">
          <dt className="text-label">Creator</dt>
          <dd className="font-mono" title={side.creatorWallet}>
            {shortAddress(side.creatorWallet)}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-label">On-chain listing</dt>
          <dd>{formatChainTime(side.listedAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-label">Hash</dt>
          <dd className="font-mono" title={side.contentHash}>
            {side.contentHash.slice(0, 10)}…
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-label">Id</dt>
          <dd className="font-mono">{side.id}</dd>
        </div>
      </dl>
      <details className="mt-2">
        <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-[11px]">Show body</summary>
        <pre className="text-muted-foreground mt-2 max-h-72 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {side.body}
        </pre>
      </details>
      <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px]" disabled={busy} onClick={onToggle}>
        {side.hidden ? <EyeIcon /> : <EyeOffIcon />}
        {side.hidden ? "Unhide" : "Hide"} in gallery
      </Button>
    </section>
  );
}
