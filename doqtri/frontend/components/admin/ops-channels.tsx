"use client";

import { useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { OPS_TONE } from "@/components/admin/ops-tone";
import { StatusTag } from "@/components/ui/status-tag";
import { formatXlm, shortKey } from "@/lib/ops/levels";
import type { OpsChannel, OpsChannels } from "@/lib/ops/types";
import { cn } from "@/lib/utils";

type Sort = "index" | "lowest";

/** Exact to the cent: the table is where a channel's balance is read closely. */
const exactXlm = (n: number) =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} XLM`;

export function sortChannels(rows: OpsChannel[], sort: Sort): OpsChannel[] {
  if (sort === "index") return [...rows].sort((a, b) => a.idx - b.idx);
  // Lowest first: a channel with no account counts as empty; an unreadable one goes last.
  const key = (r: OpsChannel) => r.xlm ?? (r.status === "crit" ? -1 : Number.POSITIVE_INFINITY);
  return [...rows].sort((a, b) => key(a) - key(b) || a.idx - b.idx);
}

function summary(rows: OpsChannel[]) {
  const known = rows.filter((r) => r.xlm !== null).map((r) => r.xlm as number);
  return {
    total: known.reduce((a, b) => a + b, 0),
    min: known.length ? Math.min(...known) : null,
    below: rows.filter((r) => r.status === "crit").length,
    leased: rows.filter((r) => r.leasedUntil !== null).length,
    unreadable: rows.filter((r) => r.status === "unknown").length,
  };
}

/** Every relay channel's balance and lease (DOQ-15), sortable by index or lowest balance. */
export function OpsChannelsSection({ channels }: { channels: OpsChannels }) {
  const [sort, setSort] = useState<Sort>("index");

  return (
    <section aria-labelledby="ops-channels" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="ops-channels" className="text-xl font-semibold tracking-tight">
            Relay channels
          </h2>
          <p className="text-muted-foreground text-[13px]">
            Each channel account&apos;s spendable XLM and lease. Refilled only by the seed script.
          </p>
        </div>
        {channels.ok && channels.rows.length > 0 && (
          <div role="group" aria-label="Sort channels" className="flex gap-1">
            {(["index", "lowest"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={sort === option}
                onClick={() => setSort(option)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[12.5px] transition-colors",
                  sort === option
                    ? "border-[var(--glass-hi)] bg-[var(--glass-strong)] text-foreground"
                    : "text-muted-foreground border-[var(--glass-lo)] hover:text-foreground",
                )}
              >
                {option === "index" ? "By index" : "Lowest first"}
              </button>
            ))}
          </div>
        )}
      </div>

      {!channels.ok ? (
        <p role="alert" className="text-muted-foreground text-[13px]">
          {channels.error}
        </p>
      ) : channels.rows.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">No channels are seeded on this network.</p>
      ) : (
        <ChannelTable channels={channels} sort={sort} />
      )}
    </section>
  );
}

function ChannelTable({ channels, sort }: { channels: Extract<OpsChannels, { ok: true }>; sort: Sort }) {
  const s = summary(channels.rows);
  const rows = sortChannels(channels.rows, sort);
  return (
    <>
      <p className="text-muted-foreground text-[13px]">
        {channels.rows.length} channels · lowest {s.min === null ? "—" : formatXlm(s.min)} · total {formatXlm(s.total)} ·{" "}
        {s.below} below {formatXlm(channels.limits.crit)} · {s.leased} leased
        {s.unreadable > 0 && <> · {s.unreadable} unreadable</>} · RELAY_POOL {channels.poolOn ? "on" : "off"}
      </p>
      <div className="overflow-x-auto rounded-xl border border-[var(--glass-lo)]">
        <table className="w-full min-w-[560px] text-[13px]">
          <caption className="sr-only">Relay channel balances</caption>
          <thead className="text-muted-foreground bg-[var(--glass)] text-left text-[12px]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">#</th>
              <th scope="col" className="px-3 py-2 font-medium">Account</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Spendable</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Lease</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.idx} className="border-t border-[var(--glass-lo)]">
                <td className="px-3 py-2 font-mono tabular-nums">{row.idx}</td>
                <td className="px-3 py-2">
                  <a
                    href={row.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={row.publicKey}
                    className="inline-flex items-center gap-1 font-mono hover:underline"
                  >
                    {shortKey(row.publicKey)}
                    <ExternalLinkIcon className="size-3" />
                  </a>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {row.xlm !== null ? exactXlm(row.xlm) : row.status === "crit" ? "No account" : "—"}
                </td>
                <td className="px-3 py-2">
                  <StatusTag tone={OPS_TONE[row.status]}>{row.status}</StatusTag>
                </td>
                <td className="text-muted-foreground px-3 py-2">
                  {row.leasedUntil ? `until ${new Date(row.leasedUntil).toISOString().slice(11, 19)} UTC` : "free"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
