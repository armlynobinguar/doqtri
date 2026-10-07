"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PROMO_STATUSES, type PromoStatus } from "@/lib/promo";
import { cn } from "@/lib/utils";

export type PromoEntry = {
  id: string;
  /** Email, wallet address, or user id when neither is known. */
  owner: string;
  imageUrls: string[];
  caption: string;
  contact: string;
  status: PromoStatus;
  createdAt: string;
  updatedAt: string;
};

type Filter = PromoStatus | "all";

const STATUS_STYLE: Record<PromoStatus, string> = {
  pending: "text-muted-foreground border-border",
  shortlisted: "text-info border-info/50",
  winner: "text-success border-success/50 bg-success/10",
  rejected: "text-destructive border-destructive/40",
};

const ACTIONS: { status: PromoStatus; label: string }[] = [
  { status: "shortlisted", label: "Shortlist" },
  { status: "winner", label: "Winner" },
  { status: "rejected", label: "Reject" },
  { status: "pending", label: "Reset" },
];

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PromoReviewList({ entries: initial }: { entries: PromoEntry[] }) {
  const [entries, setEntries] = useState(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [saving, setSaving] = useState<string | null>(null);

  const counts = Object.fromEntries(
    PROMO_STATUSES.map((s) => [s, entries.filter((e) => e.status === s).length]),
  ) as Record<PromoStatus, number>;
  const shown = filter === "all" ? entries : entries.filter((e) => e.status === filter);

  async function setStatus(entry: PromoEntry, status: PromoStatus) {
    setSaving(entry.id);
    try {
      const response = await fetch(`/api/admin/promo/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Update failed (${response.status})`);
      }
      setEntries((current) =>
        current.map((e) => (e.id === entry.id ? { ...e, status } : e)),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed");
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <div className="mt-6 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter entries">
        {(["all", ...PROMO_STATUSES] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "border-border rounded-full border px-3 py-1 text-[12px] capitalize transition-colors",
              filter === f
                ? "bg-elevated text-foreground border-foreground/50"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {f} <span className="text-label">{f === "all" ? entries.length : counts[f]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-muted-foreground mt-10 text-center text-[14px]">
          {entries.length === 0 ? "No entries yet." : "Nothing in this filter."}
        </p>
      ) : (
        <ul className="mt-5 grid gap-4 lg:grid-cols-2">
          {shown.map((entry) => (
            <li key={entry.id} className="border-border bg-card rounded-xl border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[12px]" title={entry.owner}>
                    {entry.owner}
                  </p>
                  <p className="text-label mt-0.5 text-[11px]">
                    Submitted {formatDate(entry.createdAt)}
                    {entry.updatedAt !== entry.createdAt &&
                      ` · replaced ${formatDate(entry.updatedAt)}`}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-[11px] capitalize",
                    STATUS_STYLE[entry.status],
                  )}
                >
                  {entry.status}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                {entry.imageUrls.map((url, i) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className="block">
                    {/* Signed, short-lived URLs: next/image would cache them past expiry. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={`Screenshot ${i + 1}`}
                      loading="lazy"
                      className="border-border aspect-video w-full rounded border object-cover transition-opacity hover:opacity-85"
                    />
                  </a>
                ))}
              </div>

              {entry.caption && <p className="mt-3 text-[13px] whitespace-pre-wrap">{entry.caption}</p>}
              <p className="text-muted-foreground mt-2 text-[12px]">
                Contact: {entry.contact || <span className="text-label">none given</span>}
              </p>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {ACTIONS.filter((a) => a.status !== entry.status).map((a) => (
                  <Button
                    key={a.status}
                    variant={a.status === "winner" ? "default" : "outline"}
                    size="sm"
                    disabled={saving === entry.id}
                    onClick={() => setStatus(entry, a.status)}
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
