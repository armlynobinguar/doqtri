"use client";

import { useState } from "react";
import {
  ArrowDownWideNarrowIcon,
  GaugeIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusTag } from "@/components/ui/status-tag";
import { PROMO_STATUSES, type PromoStatus } from "@/lib/promo";
import { RATING_CRITERIA, RATING_FLAGS, type StoredRating } from "@/lib/promo-rating";
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
  /** The AI rating, or null when the entry has not been rated (yet). */
  ai: StoredRating | null;
  /** Why the last rating attempt failed or was skipped. */
  aiError: string | null;
};

type Filter = PromoStatus | "all";

type Sort = "score" | "newest";

const SORTS: Record<Sort, string> = { score: "Highest rated", newest: "Newest" };

/** Parallel rating requests when catching up; keeps under OpenAI's rate limits. */
const RATE_CONCURRENCY = 3;

const STATUS_TONE: Record<PromoStatus, "planned" | "info" | "verified" | "danger"> = {
  pending: "planned",
  shortlisted: "info",
  winner: "verified",
  rejected: "danger",
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
  const [sort, setSort] = useState<Sort>("score");
  const [rating, setRating] = useState<Set<string>>(new Set());
  const [catchingUp, setCatchingUp] = useState(false);

  const counts = Object.fromEntries(
    PROMO_STATUSES.map((s) => [s, entries.filter((e) => e.status === s).length]),
  ) as Record<PromoStatus, number>;
  const unrated = entries.filter((e) => !e.ai);
  const filtered = filter === "all" ? entries : entries.filter((e) => e.status === filter);
  const shown =
    sort === "score"
      ? [...filtered].sort((a, b) => (b.ai?.score ?? -1) - (a.ai?.score ?? -1))
      : filtered;

  // Rank across every rated entry, not just the current filter.
  const rankById = new Map(
    entries
      .filter((e) => e.ai)
      .sort((a, b) => b.ai!.score - a.ai!.score)
      .map((e, i) => [e.id, i + 1]),
  );

  async function rate(entry: PromoEntry): Promise<boolean> {
    setRating((current) => new Set(current).add(entry.id));
    try {
      const response = await fetch(`/api/admin/promo/${entry.id}/rate`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as StoredRating & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Rating failed (${response.status})`);
      setEntries((current) =>
        current.map((e) =>
          e.id === entry.id
            ? { ...e, ai: { score: data.score, rating: data.rating, ratedAt: data.ratedAt }, aiError: null }
            : e,
        ),
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Rating failed";
      setEntries((current) => current.map((e) => (e.id === entry.id ? { ...e, aiError: message } : e)));
      return false;
    } finally {
      setRating((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
    }
  }

  async function rateUnrated() {
    setCatchingUp(true);
    const queue = [...unrated];
    let failed = 0;
    await Promise.all(
      Array.from({ length: Math.min(RATE_CONCURRENCY, queue.length) }, async () => {
        for (let entry = queue.shift(); entry; entry = queue.shift()) {
          if (!(await rate(entry))) failed += 1;
        }
      }),
    );
    setCatchingUp(false);
    if (failed) toast.error(`${failed} ${failed === 1 ? "entry" : "entries"} could not be rated.`);
  }

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
              "rounded-full border px-3 py-1 text-[12px] capitalize transition-colors",
              filter === f
                ? "text-foreground border-[var(--glass-hi)] bg-[var(--glass-strong)] shadow-[inset_0_1px_0_0_var(--glass-hi)]"
                : "text-muted-foreground border-[var(--glass-lo)] hover:text-foreground",
            )}
          >
            {f} <span className="text-label">{f === "all" ? entries.length : counts[f]}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={sort} onValueChange={(next) => next && setSort(next as Sort)} items={SORTS}>
          <SelectTrigger aria-label="Sort entries" size="sm" className="w-auto">
            <ArrowDownWideNarrowIcon strokeWidth={1.5} className="text-muted-foreground size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORTS) as Sort[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SORTS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {unrated.length > 0 && (
          <Button variant="outline" size="sm" disabled={catchingUp} onClick={rateUnrated}>
            {catchingUp ? (
              <Loader2Icon strokeWidth={1.5} className="animate-spin" />
            ) : (
              <GaugeIcon strokeWidth={1.5} />
            )}
            Rate unrated <span className="text-label">{unrated.length}</span>
          </Button>
        )}
        <p className="text-label text-[11px]">
          AI scores order the queue only. Check the screenshots before choosing a winner.
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="text-muted-foreground mt-10 text-center text-[14px]">
          {entries.length === 0 ? "No entries yet." : "Nothing in this filter."}
        </p>
      ) : (
        <ul className="mt-5 grid gap-4 lg:grid-cols-2">
          {shown.map((entry) => (
            <li key={entry.id} className="glass rounded-2xl p-5">
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
                <StatusTag tone={STATUS_TONE[entry.status]} className="capitalize">
                  {entry.status}
                </StatusTag>
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
                      className="aspect-video w-full rounded-lg border border-[var(--glass-lo)] object-cover transition-opacity hover:opacity-85"
                    />
                  </a>
                ))}
              </div>

              <RatingPanel
                entry={entry}
                rank={rankById.get(entry.id)}
                busy={rating.has(entry.id)}
                onRate={() => rate(entry)}
              />

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

function RatingPanel({
  entry,
  rank,
  busy,
  onRate,
}: {
  entry: PromoEntry;
  rank: number | undefined;
  busy: boolean;
  onRate: () => void;
}) {
  const { ai, aiError } = entry;

  return (
    <div className="mt-4 border-t border-[var(--glass-lo)] pt-3">
      <div className="flex items-center justify-between gap-3">
        {ai ? (
          <p className="text-[13px]">
            <GaugeIcon strokeWidth={1.5} className="text-muted-foreground mr-1.5 inline size-3.5 align-[-2px]" />
            <span className="text-[17px] tabular-nums">{ai.score}</span>
            <span className="text-label text-[11px]"> /100</span>
            {rank !== undefined && <span className="text-muted-foreground"> · rank {rank}</span>}
          </p>
        ) : (
          <p className="text-muted-foreground text-[13px]">{busy ? "Rating…" : "Not rated yet"}</p>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRate}>
          {busy ? (
            <Loader2Icon strokeWidth={1.5} className="animate-spin" />
          ) : (
            <RefreshCwIcon strokeWidth={1.5} />
          )}
          {ai ? "Re-rate" : "Rate"}
        </Button>
      </div>

      {ai && (
        <>
          {ai.rating.flags.length > 0 && (
            <p className="mt-1.5 text-[12px] text-[var(--warning)]">
              <TriangleAlertIcon strokeWidth={1.5} className="mr-1 inline size-3.5 align-[-2px]" />
              {ai.rating.flags.map((f) => RATING_FLAGS[f]).join(" · ")}
            </p>
          )}
          {ai.rating.summary && (
            <p className="text-muted-foreground mt-1.5 text-[12px]">{ai.rating.summary}</p>
          )}
          <details className="mt-2 text-[12px]">
            <summary className="text-label cursor-pointer select-none">Breakdown</summary>
            <dl className="mt-2 grid gap-1.5">
              {RATING_CRITERIA.map((c) => (
                <div key={c.key}>
                  <dt>
                    {c.label}{" "}
                    <span className="tabular-nums">{ai.rating.criteria[c.key].score}</span>
                    <span className="text-label">/10 · weight {c.weight}</span>
                  </dt>
                  <dd className="text-muted-foreground">{ai.rating.criteria[c.key].note}</dd>
                </div>
              ))}
            </dl>
            <p className="text-label mt-2">
              {ai.rating.model} · {formatDate(ai.ratedAt)}
            </p>
          </details>
        </>
      )}

      {aiError && !busy && <p className="text-label mt-1.5 text-[11px]">Last attempt: {aiError}</p>}
    </div>
  );
}
