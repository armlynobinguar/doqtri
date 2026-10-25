"use client";

import { useState } from "react";
import { FilterIcon, HistoryIcon, Link2Icon, QrCodeIcon, SearchIcon, TextCursorInputIcon, TrophyIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ReferralSource } from "@/lib/referral";
import type { ReferrerStat, SourceCounts } from "@/lib/referral-report";
import { cn } from "@/lib/utils";

export type ReferrerEntry = ReferrerStat & {
  /** Email, wallet address, or user id when neither is known. */
  owner: string;
};

export type RecentReferral = {
  referredId: string;
  referred: string;
  referrer: string;
  code: string;
  source: ReferralSource;
  createdAt: string;
};

type View = "referrers" | "recent";
type SourceFilter = ReferralSource | "all";

const SOURCES: { source: ReferralSource; label: string; Icon: typeof Link2Icon }[] = [
  { source: "link", label: "Link", Icon: Link2Icon },
  { source: "qr", label: "QR code", Icon: QrCodeIcon },
  { source: "code", label: "Typed code", Icon: TextCursorInputIcon },
];
const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.source, s.label])) as Record<ReferralSource, string>;
const SOURCE_FILTERS: Record<SourceFilter, string> = { all: "All sources", ...SOURCE_LABEL };

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function share(part: number, total: number) {
  return total === 0 ? "" : ` (${Math.round((part / total) * 100)}%)`;
}

export function ReferralReport({
  total,
  via,
  last7Days,
  last30Days,
  codes,
  referrerCount,
  referrers,
  recent,
}: {
  total: number;
  via: SourceCounts;
  last7Days: number;
  last30Days: number;
  /** Users who have a referral code, i.e. have opened their Invite tab. */
  codes: number;
  referrerCount: number;
  referrers: ReferrerEntry[];
  recent: RecentReferral[];
}) {
  const [view, setView] = useState<View>("referrers");
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const shownReferrers = referrers.filter(
    (r) => !q || r.owner.toLowerCase().includes(q) || r.code.includes(q),
  );
  const shownRecent = recent.filter(
    (r) =>
      (source === "all" || r.source === source) &&
      (!q || [r.referred, r.referrer, r.code].some((v) => v.toLowerCase().includes(q))),
  );

  return (
    <>
      <section className="glass mt-6 grid gap-4 rounded-2xl px-5 py-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-10">
        <div>
          <p className="display text-4xl" data-testid="referral-total">
            {total}
          </p>
          <p className="text-muted-foreground mt-1 text-[13px]">referred sign-ups</p>
        </div>
        <dl className="grid content-center gap-x-8 gap-y-2 text-[13px] sm:grid-flow-col sm:grid-cols-2 sm:grid-rows-3">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Last 7 days</dt>
            <dd>{last7Days}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Last 30 days</dt>
            <dd>{last30Days}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Referrers</dt>
            <dd>
              {referrerCount} <span className="text-label text-[11px]">of {codes} with a code</span>
            </dd>
          </div>
          {SOURCES.map(({ source: s, label, Icon }) => (
            <div key={s} className="flex justify-between gap-4" data-testid={`referral-via-${s}`}>
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Icon className="size-3.5" strokeWidth={1.5} />
                {label}
              </dt>
              <dd>
                {via[s]}
                <span className="text-label text-[11px]">{share(via[s], total)}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Referral view">
          {(
            [
              { id: "referrers", label: "Top referrers", Icon: TrophyIcon, count: referrerCount },
              { id: "recent", label: "Recent sign-ups", Icon: HistoryIcon, count: total },
            ] as const
          ).map(({ id, label, Icon, count }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              data-testid={`referral-view-${id}`}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors",
                view === id
                  ? "text-foreground border-[var(--glass-hi)] bg-[var(--glass-strong)] shadow-[inset_0_1px_0_0_var(--glass-hi)]"
                  : "text-muted-foreground hover:text-foreground border-[var(--glass-lo)]",
              )}
            >
              <Icon className="size-3.5" strokeWidth={1.5} />
              {label} <span className="text-label">{count}</span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2 max-sm:ml-0 max-sm:w-full">
          {view === "recent" ? (
            <Select value={source} onValueChange={(next) => next && setSource(next as SourceFilter)} items={SOURCE_FILTERS}>
              <SelectTrigger aria-label="Filter by source" size="sm" className="w-auto">
                <FilterIcon strokeWidth={1.5} className="text-muted-foreground size-3.5" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SOURCE_FILTERS) as SourceFilter[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {SOURCE_FILTERS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <label className="relative max-sm:flex-1">
            <SearchIcon
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
              strokeWidth={1.5}
            />
            <Input
              type="search"
              placeholder="Email, wallet or code"
              aria-label="Search referrals"
              className="h-8 pl-8 text-[13px] sm:w-60"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      </div>

      {view === "referrers" ? (
        <ReferrerTable
          referrers={shownReferrers}
          empty={referrers.length === 0}
          note={referrerCount > referrers.length ? `Showing the top ${referrers.length} of ${referrerCount}.` : null}
        />
      ) : (
        <RecentTable
          rows={shownRecent}
          empty={recent.length === 0}
          note={total > recent.length ? `Showing the latest ${recent.length} of ${total}.` : null}
        />
      )}
    </>
  );
}

function Empty({ none }: { none: boolean }) {
  return (
    <p className="text-muted-foreground mt-10 text-center text-[14px]">
      {none ? "No referrals yet." : "Nothing matches."}
    </p>
  );
}

const TH = "text-label px-3 py-2 text-left text-[11px] font-normal tracking-wide uppercase";
const TD = "px-3 py-2.5 align-top";

function ReferrerTable({
  referrers,
  empty,
  note,
}: {
  referrers: ReferrerEntry[];
  empty: boolean;
  note: string | null;
}) {
  if (referrers.length === 0) return <Empty none={empty} />;
  return (
    <div className="glass mt-4 overflow-x-auto rounded-2xl">
      <table className="w-full min-w-[640px] text-[13px]" data-testid="referrer-table">
        <thead className="border-b border-[var(--glass-lo)]">
          <tr>
            <th className={TH}>Referrer</th>
            <th className={TH}>Code</th>
            <th className={cn(TH, "text-right")}>Total</th>
            {SOURCES.map((s) => (
              <th key={s.source} className={cn(TH, "text-right")}>
                {s.label}
              </th>
            ))}
            <th className={TH}>Latest</th>
          </tr>
        </thead>
        <tbody>
          {referrers.map((r) => (
            <tr key={r.userId} className="border-b border-[var(--glass-lo)] last:border-0">
              <td className={cn(TD, "max-w-[18rem] truncate font-mono text-[12px]")} title={r.owner}>
                {r.owner}
              </td>
              <td className={cn(TD, "font-mono text-[12px]")}>{r.code}</td>
              <td className={cn(TD, "text-right")}>{r.total}</td>
              {SOURCES.map((s) => (
                <td key={s.source} className={cn(TD, "text-muted-foreground text-right")}>
                  {r.via[s.source]}
                </td>
              ))}
              <td className={cn(TD, "text-muted-foreground whitespace-nowrap")}>{formatDate(r.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {note ? <p className="text-label px-3 py-2 text-[11px]">{note}</p> : null}
    </div>
  );
}

function RecentTable({ rows, empty, note }: { rows: RecentReferral[]; empty: boolean; note: string | null }) {
  if (rows.length === 0) return <Empty none={empty} />;
  return (
    <div className="glass mt-4 overflow-x-auto rounded-2xl">
      <table className="w-full min-w-[640px] text-[13px]" data-testid="recent-referral-table">
        <thead className="border-b border-[var(--glass-lo)]">
          <tr>
            <th className={TH}>Signed up</th>
            <th className={TH}>New account</th>
            <th className={TH}>Referred by</th>
            <th className={TH}>Via</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.referredId} className="border-b border-[var(--glass-lo)] last:border-0">
              <td className={cn(TD, "text-muted-foreground whitespace-nowrap")}>{formatDate(r.createdAt)}</td>
              <td className={cn(TD, "max-w-[16rem] truncate font-mono text-[12px]")} title={r.referred}>
                {r.referred}
              </td>
              <td className={cn(TD, "max-w-[16rem] truncate font-mono text-[12px]")} title={r.referrer}>
                {r.referrer} <span className="text-label">· {r.code}</span>
              </td>
              <td className={cn(TD, "text-muted-foreground")}>{SOURCE_LABEL[r.source]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {note ? <p className="text-label px-3 py-2 text-[11px]">{note}</p> : null}
    </div>
  );
}
