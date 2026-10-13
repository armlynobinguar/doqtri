"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArchiveIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CoinsIcon,
  CopyPlusIcon,
  ExternalLinkIcon,
  GiftIcon,
  GitForkIcon,
  HandCoinsIcon,
  LayoutGridIcon,
  Loader2Icon,
  RotateCwIcon,
  SearchIcon,
  ShoppingBagIcon,
  StoreIcon,
  TagIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWallet } from "@/components/vault/wallet-provider";
import { expertTxUrl } from "@/lib/stellar/config";
import { cn } from "@/lib/utils";
import { TokenIcon } from "@/components/brand/token-icon";
import { marketToken } from "@/lib/stellar/market-config";
import { TemplateMarket } from "@/lib/stellar/market-client";
import { formatAmount, parseAmount, shortAddress, type EarningsSummary, type EarningsTemplate } from "@/lib/market";

type Load =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "ready"; summary: EarningsSummary };

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The creator dashboard (the "Yours" tab of /vault/templates): totals per token, then one card per
 * template with its sales, derivatives and the price / listing controls.
 * Numbers come from /api/market/earnings, which re-reads them from the chain.
 */
export function EarningsView() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/market/earnings", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as EarningsSummary & {
        error?: string;
      };
      if (res.status === 503) {
        setLoad({ kind: "unavailable" });
        return;
      }
      if (!res.ok) throw new Error(body.error || "Your earnings couldn't be loaded.");
      setLoad({ kind: "ready", summary: body });
    } catch (error) {
      setLoad({
        kind: "error",
        message: error instanceof Error ? error.message : "Your earnings couldn't be loaded.",
      });
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refetch();
    })();
  }, [refetch]);

  return (
    <div data-testid="earnings-view">
      {load.kind === "loading" ? (
        <p className="text-muted-foreground mt-6 flex items-center gap-2 text-[13px]">
          <Loader2Icon className="size-4 animate-spin" /> Reading your templates from the ledger…
        </p>
      ) : load.kind === "unavailable" ? (
        <p className="text-muted-foreground mt-6 text-[14px]">
          The template marketplace isn&apos;t available on this network.
        </p>
      ) : load.kind === "error" ? (
        <div className="mt-6 grid justify-items-start gap-3">
          <p role="alert" className="text-destructive text-[14px]">
            {load.message}
          </p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            <RotateCwIcon />
            Try again
          </Button>
        </div>
      ) : (
        <Summary summary={load.summary} onChanged={refetch} />
      )}
    </div>
  );
}

function Summary({ summary, onChanged }: { summary: EarningsSummary; onChanged: () => Promise<void> }) {
  if (summary.templates.length === 0 && summary.royalties.length === 0) {
    return (
      <div className="glass mt-8 rounded-2xl p-6 text-[14px]" data-testid="earnings-empty">
        <p className="text-foreground font-medium">You haven&apos;t published a template yet.</p>
        <p className="text-muted-foreground mt-2">
          Open a note, go to its <span className="text-foreground">Stellar proof</span> panel and choose{" "}
          <span className="text-foreground">Publish as template</span>. Anyone on Doqtri can then start from it, and you
          earn from each sale and tip.
        </p>
      </div>
    );
  }

  return (
    <>
      {summary.totals.length ? (
        <ul className="mt-2 grid gap-4" aria-label="Totals">
          {summary.totals.map((t) => (
            <li
              key={t.tokenCode}
              className="glass grid gap-5 rounded-3xl p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:items-center"
              data-testid={`earnings-total-${t.tokenCode}`}
            >
              <div className="flex items-center gap-5">
                <TokenIcon code={t.tokenCode} className="size-11 shrink-0 opacity-90" />
                <div className="min-w-0">
                  <p className="text-label text-[12px]">Total earned</p>
                  <p className="display text-foreground mt-1 flex items-baseline gap-2 tabular-nums">
                    <span className="text-4xl lg:text-[44px]">
                      {formatAmount(BigInt(t.earned) + BigInt(t.tips) + BigInt(t.royalties))}
                    </span>
                    <span className="text-label text-base font-medium">{t.tokenCode}</span>
                  </p>
                </div>
              </div>
              <dl className="grid gap-3 sm:grid-cols-3">
                <Stat
                  icon={ShoppingBagIcon}
                  label="Sales"
                  value={formatAmount(BigInt(t.earned))}
                  unit={t.tokenCode}
                  large
                />
                <Stat icon={HandCoinsIcon} label="Tips" value={formatAmount(BigInt(t.tips))} unit={t.tokenCode} large />
                <Stat
                  icon={GitForkIcon}
                  label="Royalties"
                  value={formatAmount(BigInt(t.royalties))}
                  unit={t.tokenCode}
                  large
                />
              </dl>
            </li>
          ))}
        </ul>
      ) : null}

      {summary.templates.length ? <TemplateList templates={summary.templates} onChanged={onChanged} /> : null}

      {summary.royalties.length ? (
        <section className="mt-8" aria-label="Royalties">
          <h2 className="text-foreground text-[15px] font-semibold">Royalties from derivatives</h2>
          <p className="text-muted-foreground mt-1 text-[12px]">
            Other creators&apos; templates based on yours. You earn the parent share of each of their sales.
          </p>
          <div className="glass mt-3 overflow-x-auto rounded-2xl">
            <table className="w-full text-left text-[12px]">
              <thead className="text-label">
                <tr>
                  <th className="px-4 py-2 font-medium">Derivative</th>
                  <th className="px-4 py-2 font-medium">Based on</th>
                  <th className="px-4 py-2 font-medium">Sales</th>
                  <th className="px-4 py-2 font-medium">Earned</th>
                </tr>
              </thead>
              <tbody>
                {summary.royalties.map((r) => (
                  <tr key={r.templateId} className="border-t border-[var(--glass-lo)]">
                    <td className="text-foreground px-4 py-2">{r.title}</td>
                    <td className="text-muted-foreground px-4 py-2">{r.parentTitle}</td>
                    <td className="px-4 py-2 tabular-nums">{r.sales}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {formatAmount(BigInt(r.total))} {r.tokenCode}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

type Step = "signing" | "syncing" | null;

function TemplateCard({ template: t, onChanged }: { template: EarningsTemplate; onChanged: () => Promise<void> }) {
  const wallet = useWallet();
  const token = marketToken(t.token);
  const [price, setPrice] = useState(formatAmount(BigInt(t.price)));
  const [step, setStep] = useState<Step>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = step !== null;

  const parsed = parseAmount(price);
  const priceError =
    parsed === null
      ? "Enter a plain number, like 2.5"
      : parsed > BigInt(0) && token && parsed < token.minPrice
        ? `The lowest paid price in ${token.code} is ${formatAmount(token.minPrice)}`
        : null;
  const priceChanged = parsed !== null && parsed !== BigInt(t.price);

  /** Sign a change on-chain, then have the server re-read it for the gallery. */
  async function change(label: string, write: (address: string) => Promise<{ txHash: string }>) {
    setError(null);
    try {
      setStep("signing");
      const address = await wallet.ensureWallet();
      const { txHash } = await write(address);
      setStep("syncing");
      const res = await fetch("/api/market/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: t.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // On-chain already; only the gallery's cache is behind.
        toast.warning(body.error || "Changed on-chain; the gallery will catch up shortly.");
      }
      toast.success(label, {
        action: {
          label: "View tx",
          onClick: () => window.open(expertTxUrl(txHash), "_blank", "noopener,noreferrer"),
        },
      });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change could not be made.");
    } finally {
      setStep(null);
      void wallet.refreshBalance();
    }
  }

  return (
    <li className="glass rounded-3xl p-6 lg:p-7" data-testid={`earnings-template-${t.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-foreground truncate text-lg font-semibold tracking-tight">{t.title}</p>
          <p className="text-label mt-1 text-[12px]">
            {!t.listed ? <span className="text-foreground">Delisted · </span> : null}
            {t.hidden ? <span className="text-destructive">Hidden from the gallery · </span> : null}
            Listed {formatDate(t.listedAt)}
            {t.parent ? (
              <>
                {" "}
                · Derived from <span className="text-muted-foreground">{t.parent.title}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          icon={TagIcon}
          token={BigInt(t.price) === BigInt(0) ? undefined : t.tokenCode}
          label="Price"
          value={BigInt(t.price) === BigInt(0) ? "Free" : formatAmount(BigInt(t.price))}
          unit={BigInt(t.price) === BigInt(0) ? undefined : t.tokenCode}
        />
        <Stat icon={ShoppingBagIcon} label="Sales" value={String(t.sales)} />
        <Stat icon={CopyPlusIcon} label="Uses" value={String(t.uses)} />
        <Stat icon={WalletIcon} label="Earned" value={formatAmount(BigInt(t.earned))} unit={t.tokenCode} />
        <Stat icon={HandCoinsIcon} label="Tips" value={formatAmount(BigInt(t.tips))} unit={t.tokenCode} />
      </dl>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="text-muted-foreground grid gap-1 text-[11px]">
          New price in {t.tokenCode} (0 = free)
          <Input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            disabled={busy}
            aria-invalid={priceError !== null}
            className="h-8 w-36 text-[12px]"
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || priceError !== null || !priceChanged}
          onClick={() =>
            void change(
              `Price set to ${parsed === BigInt(0) ? "free" : `${formatAmount(parsed!)} ${t.tokenCode}`}`,
              (a) => TemplateMarket.updatePrice(a, t.id, parsed!),
            )
          }
        >
          <TagIcon />
          Change price
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void change(t.listed ? "Delisted" : "Relisted", (a) => TemplateMarket.setListed(a, t.id, !t.listed))
          }
        >
          {t.listed ? <ArchiveIcon /> : <StoreIcon />}
          {t.listed ? "Delist" : "Relist"}
        </Button>
        {busy ? (
          <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
            <Loader2Icon className="size-3.5 animate-spin" />
            {step === "signing" ? "Sign in wallet…" : "Updating the gallery…"}
          </span>
        ) : null}
      </div>
      {priceError && price !== "" ? <p className="text-warning mt-1 text-[11px]">{priceError}</p> : null}
      {error ? (
        <p role="alert" className="text-destructive mt-2 text-[12px]">
          {error}
        </p>
      ) : null}

      {t.derived.length ? (
        <div className="mt-4">
          <p className="text-label text-[11px]">Derived templates</p>
          <ul className="mt-1 grid gap-1 text-[12px]">
            {t.derived.map((d) => (
              <li key={d.id} className="flex flex-wrap gap-x-2">
                <span className="text-foreground">{d.title}</span>
                <span className="text-muted-foreground font-mono">{shortAddress(d.creatorWallet)}</span>
                <span className="text-muted-foreground">
                  {d.sales} {d.sales === 1 ? "sale" : "sales"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {t.recentSales.length ? (
        <div className="mt-4 overflow-x-auto">
          <p className="text-label text-[11px]">Recent sales</p>
          <table className="mt-1 w-full text-left text-[12px]">
            <thead className="text-label">
              <tr>
                <th className="py-1 pr-3 font-medium">Buyer</th>
                <th className="py-1 pr-3 font-medium">Paid</th>
                <th className="py-1 pr-3 font-medium">You got</th>
                <th className="py-1 pr-3 font-medium">Date</th>
                <th className="py-1 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody>
              {t.recentSales.map((s, i) => (
                <tr key={`${s.buyerWallet}-${i}`} className="border-t border-[var(--glass-lo)]">
                  <td className="py-1 pr-3 font-mono">{shortAddress(s.buyerWallet)}</td>
                  <td className="py-1 pr-3 tabular-nums">
                    {formatAmount(BigInt(s.amount))} {t.tokenCode}
                  </td>
                  <td className="py-1 pr-3 tabular-nums">
                    {formatAmount(BigInt(s.creatorCut))} {t.tokenCode}
                  </td>
                  <td className="text-muted-foreground py-1 pr-3">{formatDate(s.createdAt)}</td>
                  <td className="py-1">
                    {s.txHash ? (
                      <a
                        href={expertTxUrl(s.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                      >
                        {s.txHash.slice(0, 8)}
                        <ExternalLinkIcon className="size-3" strokeWidth={1.5} />
                      </a>
                    ) : (
                      <span className="text-label">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </li>
  );
}

const FILTERS = ["All", "Listed", "Delisted", "Free", "Paid"] as const;
type Filter = (typeof FILTERS)[number];

/** Same symbols as elsewhere: the store (publish), gift / coins (price cards). */
const FILTER_ICONS: Record<Filter, LucideIcon> = {
  All: LayoutGridIcon,
  Listed: StoreIcon,
  Delisted: ArchiveIcon,
  Free: GiftIcon,
  Paid: CoinsIcon,
};

const PAGE_SIZES = [5, 10, 20] as const;
const PAGE_SIZE_KEY = "doqtri:earnings-page-size";

function matches(t: EarningsTemplate, filter: Filter): boolean {
  const free = BigInt(t.price) === BigInt(0);
  switch (filter) {
    case "All":
      return true;
    case "Listed":
      return t.listed;
    case "Delisted":
      return !t.listed;
    case "Free":
      return free;
    case "Paid":
      return !free;
  }
}

/** A remembered per-browser convenience; falls back to 5 when storage is unavailable. */
function storedPageSize(): number {
  if (typeof window === "undefined") return PAGE_SIZES[0];
  try {
    const n = Number(window.localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
}

const chip =
  "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden";

/** "Your templates": search, filter and page through the creator's templates. */
function TemplateList({ templates, onChanged }: { templates: EarningsTemplate[]; onChanged: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  // Rendered only after the client fetched the summary, never on the server,
  // so reading storage here can't cause a hydration mismatch.
  const [pageSize, setPageSizeState] = useState<number>(storedPageSize);
  const [page, setPage] = useState(1);

  function setPageSize(n: number) {
    setPageSizeState(n);
    setPage(1);
    try {
      window.localStorage.setItem(PAGE_SIZE_KEY, String(n));
    } catch {
      // Storage blocked: the choice just isn't remembered.
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((t) => matches(t, filter) && (!q || t.title.toLowerCase().includes(q)));
  }, [templates, query, filter]);

  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize;
  const slice = shown.slice(start, start + pageSize);

  return (
    <section className="mt-8" aria-label="Your templates">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-foreground text-[15px] font-semibold">
          Your templates{" "}
          <span className="text-label ml-1 text-[12px] font-normal tabular-nums">{templates.length}</span>
        </h2>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-48 flex-1 sm:max-w-72">
          <span className="sr-only">Search your templates</span>
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search by title"
            className="h-8 pl-8 text-[13px]"
            data-testid="earnings-search"
          />
        </label>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Filter templates">
          {FILTERS.map((f) => {
            const Icon = FILTER_ICONS[f];
            return (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                data-testid={`earnings-filter-${f.toLowerCase()}`}
                onClick={() => {
                  setFilter(f);
                  setPage(1);
                }}
                className={cn(
                  chip,
                  "inline-flex items-center gap-1.5",
                  filter === f
                    ? "border-[var(--glass-hi)] bg-[var(--glass-strong)] text-foreground"
                    : "text-muted-foreground border-[var(--glass-lo)] hover:text-foreground",
                )}
              >
                <Icon className="size-3" strokeWidth={1.75} aria-hidden />
                {f}
              </button>
            );
          })}
        </div>
      </div>

      {slice.length ? (
        <ul className="mt-3 grid gap-4">
          {slice.map((t) => (
            <TemplateCard key={t.id} template={t} onChanged={onChanged} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground glass mt-3 rounded-2xl p-5 text-[13px]" data-testid="earnings-no-match">
          No templates match{query.trim() ? ` “${query.trim()}”` : ""}
          {filter !== "All" ? ` in ${filter.toLowerCase()}` : ""}.
        </p>
      )}

      <nav
        className="text-muted-foreground mt-3 flex flex-wrap items-center justify-between gap-3 text-[12px]"
        aria-label="Pagination"
      >
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Templates per page">
          <span className="mr-1">Per page</span>
          {PAGE_SIZES.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={pageSize === n}
              data-testid={`earnings-page-size-${n}`}
              onClick={() => setPageSize(n)}
              className={cn(
                chip,
                "tabular-nums",
                pageSize === n
                  ? "border-[var(--glass-hi)] bg-[var(--glass-strong)] text-foreground"
                  : "border-[var(--glass-lo)] hover:text-foreground",
              )}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="tabular-nums" data-testid="earnings-range" aria-live="polite">
            {shown.length ? `${start + 1}–${start + slice.length} of ${shown.length}` : "0 of 0"}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label="Previous page"
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
            data-testid="earnings-prev"
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label="Next page"
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
            data-testid="earnings-next"
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </nav>
    </section>
  );
}

/**
 * One figure with its icon: a quiet label with a muted icon, then the number,
 * the unit small. `large` (the totals card) sits in a faint outline; on a
 * template card it's bare. `token` swaps the icon for that token's badge.
 */
function Stat({
  icon: Icon,
  token,
  label,
  value,
  unit,
  large = false,
}: {
  icon: LucideIcon;
  token?: string;
  label: string;
  value: string;
  unit?: string;
  large?: boolean;
}) {
  return (
    <div className={cn("min-w-0", large && "rounded-2xl border border-[var(--glass-lo)] px-4 py-3")}>
      <dt className="text-label flex items-center gap-1.5 text-[12px]">
        {token ? (
          <TokenIcon code={token} className="size-3.5 opacity-80" />
        ) : (
          <Icon className="size-3.5" strokeWidth={1.5} aria-hidden />
        )}
        {label}
      </dt>
      <dd className="text-foreground/90 mt-1 flex flex-wrap items-baseline gap-x-1 tabular-nums">
        <span className={cn("tracking-tight", large ? "text-2xl font-medium" : "text-lg")}>{value}</span>
        {unit ? <span className="text-label text-[12px]">{unit}</span> : null}
      </dd>
    </div>
  );
}
