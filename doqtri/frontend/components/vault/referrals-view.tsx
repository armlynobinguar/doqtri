"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  BadgeCheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CoinsIcon,
  CopyIcon,
  GiftIcon,
  HandCoinsIcon,
  HourglassIcon,
  Loader2Icon,
  RotateCwIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import { payoutCard } from "@/components/vault/referral-payout-client";
import { ReferralPayoutDialog } from "@/components/vault/referral-payout-dialog";
import { createReferralsPager, type ReferralsRead } from "@/components/vault/referrals-pager";
import { useIsCompactVault } from "@/hooks/use-mobile";
import type { ReferralDashboard, ReferralLimit, ReferralListRow, ReferralStatus } from "@/lib/referral-dashboard";
import type { PayoutState, PayoutSummary } from "@/lib/referral-payout";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_PHP } from "@/lib/referral-program";
import { cn } from "@/lib/utils";

/** The commitment in the Terms (DOQ-29), which the rules panel will link to once they merge. */
const PAYOUT_WITHIN_DAYS = 30;

const LIMIT_CONTACT = "team@doqtri.xyz";

const STATUS: Record<ReferralStatus, { label: string; tone: "planned" | "verified" | "warning" | "onchain" | "danger" }> = {
  pending: { label: "Pending", tone: "planned" },
  eligible: { label: "Eligible", tone: "verified" },
  over_limit: { label: "Over limit", tone: "warning" },
  paid: { label: "Paid", tone: "onchain" },
  not_eligible: { label: "Not eligible", tone: "danger" },
};

const FAILED = "Your referrals couldn't be loaded.";

/** A focusable button that's disabled has no `disabled` attribute for the Button's own styles to find. */
const PAGE_BUTTON = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

/** `day` is a UTC day from the server, so it's read in UTC: anywhere else it could show the day before. */
function formatDay(day: string) {
  return new Date(day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US");
}

function rewards(count: number) {
  return `${count} ${count === 1 ? "reward" : "rewards"}`;
}

/**
 * One page from the route, or what to say instead. Only the route's own words
 * reach the user: a dropped connection's message means nothing to them, and an
 * answer without totals would break the page rather than explain anything.
 */
export async function readReferrals(page: number): Promise<ReferralsRead> {
  try {
    const res = await fetch(`/api/referrals?page=${page}`, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (ReferralDashboard & { error?: string }) | null;
    if (!res.ok || !body?.totals) return { kind: "error", message: body?.error || FAILED };
    return { kind: "ready", data: body };
  } catch {
    return { kind: "error", message: FAILED };
  }
}

/**
 * The referral dashboard: totals, the list, and the rules. Numbers come from
 * /api/referrals, which reads them from the stored rewards and masks everyone in
 * them (D-111).
 */
export function ReferralsView({ inviteUrl }: { inviteUrl: string | null }) {
  const [pager] = useState(() => createReferralsPager(readReferrals));
  const { data, busy, error } = useSyncExternalStore(pager.subscribe, pager.getState, pager.getState);

  useEffect(() => {
    void pager.goTo(1);
  }, [pager]);

  return (
    <div className="h-full overflow-y-auto" data-testid="referrals-page">
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 sm:px-8 sm:py-8">
        <header>
          <h1 className="display flex items-center gap-2 text-3xl">
            <GiftIcon className="size-6" strokeWidth={1.5} />
            Referrals
          </h1>
          <p className="text-muted-foreground mt-2 text-[14px]">
            Who signed up with your link, and which of them earn you a reward.
          </p>
        </header>

        {data ? (
          <ReferralsDashboard
            data={data}
            inviteUrl={inviteUrl}
            busy={busy}
            pageError={error}
            onPage={(page) => void pager.goTo(page)}
            onRetry={() => void pager.retry()}
          />
        ) : error ? (
          <ReferralsError message={error} busy={busy} onRetry={() => void pager.retry()} />
        ) : (
          <p className="text-muted-foreground mt-2 flex items-center gap-2 text-[13px]" data-testid="referrals-loading">
            <Loader2Icon className="size-4 animate-spin" /> Loading your referrals…
          </p>
        )}
      </main>
    </div>
  );
}

export function ReferralsError({
  message,
  busy = false,
  onRetry,
}: {
  message: string;
  busy?: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mt-2 grid justify-items-start gap-3" data-testid="referrals-error">
      <p role="alert" className="text-destructive text-[14px]">
        {message}
      </p>
      <RetryButton size="sm" busy={busy} onRetry={onRetry} />
    </div>
  );
}

/** Focusable while busy: disabling the button under a keyboard user's focus would drop it to the page. */
function RetryButton({ size, busy, onRetry }: { size: "xs" | "sm"; busy: boolean; onRetry: () => void }) {
  return (
    <Button
      size={size}
      variant="outline"
      disabled={busy}
      focusableWhenDisabled
      className={PAGE_BUTTON}
      onClick={onRetry}
      data-testid="referrals-retry"
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />}
      Try again
    </Button>
  );
}

export function ReferralsDashboard({
  data,
  inviteUrl,
  busy = false,
  pageError = null,
  onPage = () => {},
  onRetry = () => {},
}: {
  data: ReferralDashboard;
  inviteUrl: string | null;
  busy?: boolean;
  /** A turn of the page failed; `data` is still the page that was on screen. */
  pageError?: string | null;
  onPage?: (page: number) => void;
  onRetry?: () => void;
}) {
  const { totals, limit } = data;
  return (
    <>
      {limit.reached ? <LimitNotice limit={limit} /> : null}
      <PayoutPrompt payout={data.payout} payoutNeeded={data.payoutNeeded} unpaidPhp={totals.unpaidPhp} />

      {totals.referred === 0 ? (
        <EmptyState inviteUrl={inviteUrl} />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Totals" data-testid="referrals-totals">
            <Figure
              icon={UsersIcon}
              label="Referred"
              value={totals.referred}
              testId="referrals-total-referred"
              className="max-lg:col-span-2"
            />
            <Figure icon={BadgeCheckIcon} label="Eligible" value={totals.eligible} testId="referrals-total-eligible" />
            <Figure icon={CoinsIcon} label="Earned" value={totals.earnedPhp} unit="PHP" testId="referrals-total-earned" />
            <Figure icon={HourglassIcon} label="Unpaid" value={totals.unpaidPhp} unit="PHP" testId="referrals-total-unpaid" />
            <Figure icon={HandCoinsIcon} label="Paid" value={totals.paidPhp} unit="PHP" testId="referrals-total-paid" />
          </dl>
          <ReferralList data={data} busy={busy} pageError={pageError} onPage={onPage} onRetry={onRetry} />
        </>
      )}

      <Rules limit={limit.limit} />
    </>
  );
}

function LimitNotice({ limit }: { limit: ReferralLimit }) {
  return (
    <p
      role="status"
      data-testid="referrals-limit-notice"
      className="border-warning/40 bg-warning/10 flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]"
    >
      <TriangleAlertIcon className="text-warning mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        You&apos;ve reached the limit of {rewards(limit.limit)}. To request more, email{" "}
        <a href={`mailto:${LIMIT_CONTACT}`} className="underline underline-offset-2 [overflow-wrap:anywhere]">
          {LIMIT_CONTACT}
        </a>
      </span>
    </p>
  );
}

const PAYOUT_CARD_TITLE: Record<"needed" | "saved" | "empty" | "unavailable", string> = {
  needed: "Payout details needed",
  saved: "Payout details saved",
  empty: "No payout details saved",
  unavailable: "Your payout details couldn't be loaded",
};

/**
 * Where the payout questionnaire opens (DOQ-25). One card whatever it says, so the
 * button that opened the form keeps a keyboard user's focus when the form closes
 * and the words change. "Needed" until details are saved; after that it's the
 * saved state, showing only what the summary masks: the method, the last few
 * characters and, for XLM, the memo's type. The details themselves are only ever
 * in the form. See payoutCard().
 */
function PayoutPrompt({
  payout,
  payoutNeeded,
  unpaidPhp,
}: {
  payout: PayoutState;
  payoutNeeded: boolean;
  unpaidPhp: number;
}) {
  const [justSaved, setJustSaved] = useState<PayoutSummary | null>(null);
  const [open, setOpen] = useState(false);
  const card = payoutCard(payout, payoutNeeded, justSaved);
  if (!card) return null;

  return (
    <>
      <div
        role="status"
        data-testid={`referrals-payout-${card.kind === "needed" ? "prompt" : card.kind}`}
        className="flex flex-wrap items-start gap-3 rounded-xl border border-[var(--glass-lo)] bg-[var(--glass)] px-4 py-3 text-[13px]"
      >
        <WalletIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-foreground font-medium">{PAYOUT_CARD_TITLE[card.kind]}</p>
          <p className="text-muted-foreground mt-1 [overflow-wrap:anywhere]" data-testid="referrals-payout-text">
            {card.kind === "needed" ? (
              <>You have {formatNumber(unpaidPhp)} PHP unpaid. We need your payout details before we can pay it.</>
            ) : card.kind === "saved" ? (
              <>
                {card.summary.label} ending in <span className="font-mono">{card.summary.last4}</span>
                {card.summary.memoType ? `, with ${card.summary.memoType === "id" ? "an ID" : "a text"} memo` : null}
              </>
            ) : card.kind === "unavailable" ? (
              <>Try reloading the page in a moment.</>
            ) : (
              <>Add them so that we can pay any future rewards.</>
            )}
          </p>
        </div>
        {/* Nothing to open while it's unknown what's saved: the form would fail the same way. */}
        {card.kind !== "unavailable" ? (
          <Button
            type="button"
            size="sm"
            variant={card.kind === "needed" ? "default" : "outline"}
            onClick={() => setOpen(true)}
            data-testid="referrals-payout-open"
          >
            {card.kind !== "saved" ? "Add details" : card.canEdit ? "Edit" : "View"}
          </Button>
        ) : null}
      </div>
      <ReferralPayoutDialog open={open} onOpenChange={setOpen} onSaved={setJustSaved} />
    </>
  );
}

function EmptyState({ inviteUrl }: { inviteUrl: string | null }) {
  return (
    <div className="glass grid justify-items-start gap-3 rounded-2xl p-6 text-[14px]" data-testid="referrals-empty">
      <div>
        <p className="text-foreground font-medium">No referrals yet</p>
        <p className="text-muted-foreground mt-2">
          Share your link. When someone signs up with it, they appear here with their progress.
        </p>
      </div>
      {inviteUrl ? (
        <Button type="button" size="sm" onClick={() => void copyLink(inviteUrl)} data-testid="referrals-copy-link">
          <CopyIcon />
          Copy link
        </Button>
      ) : (
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/vault/profile?tab=invite" />}>
          <GiftIcon />
          Get your link
        </Button>
      )}
    </div>
  );
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Referral link copied");
  } catch {
    toast.error("Could not copy referral link");
  }
}

function ReferralList({
  data,
  busy,
  pageError,
  onPage,
  onRetry,
}: {
  data: ReferralDashboard;
  busy: boolean;
  pageError: string | null;
  onPage: (page: number) => void;
  onRetry: () => void;
}) {
  const { rows, page, pages, pageSize, totals } = data;
  const start = (page - 1) * pageSize;
  const isCompact = useIsCompactVault();
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // A phone's list is long and the buttons are under it, so a new page would
  // open at its end. Instant, so reduced motion has nothing to respect.
  const shownPage = useRef(page);
  useEffect(() => {
    if (shownPage.current === page) return;
    shownPage.current = page;
    if (isCompact) section.current?.scrollIntoView({ block: "start" });
  }, [page, isCompact]);

  // Try again goes away when it works, and a keyboard user's focus would go with
  // it: hand that to the list it just brought back.
  const hadPageError = useRef(false);
  useEffect(() => {
    if (hadPageError.current && !pageError && document.activeElement === document.body) {
      heading.current?.focus({ preventScroll: true });
    }
    hadPageError.current = Boolean(pageError);
  }, [pageError]);

  return (
    <section ref={section} aria-label="Your referrals" className="mt-2 scroll-mt-4">
      <h2 ref={heading} tabIndex={-1} className="text-foreground text-[15px] font-semibold outline-none">
        Your referrals{" "}
        <span className="text-label ml-1 text-[12px] font-normal tabular-nums">{formatNumber(totals.referred)}</span>
      </h2>
      <div className="glass mt-3 overflow-hidden rounded-2xl" aria-busy={busy || undefined}>
        <div className="text-label hidden grid-cols-[minmax(0,1fr)_7rem_6rem_11rem] gap-x-3 px-4 py-2 text-[12px] font-medium sm:grid">
          <span>Person</span>
          <span>Joined</span>
          <span>Activity</span>
          <span className="justify-self-end">Status</span>
        </div>
        <ul data-testid="referrals-list">
          {rows.map((row, index) => (
            // No id reaches the browser (D-111); a row's place in its page is all there is.
            <Row key={start + index} row={row} />
          ))}
        </ul>
      </div>
      {pageError ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2" data-testid="referrals-page-error">
          <p role="alert" className="text-destructive text-[12px]">
            {pageError}
          </p>
          <RetryButton size="xs" busy={busy} onRetry={onRetry} />
        </div>
      ) : null}
      {pages > 1 ? (
        <PageNav page={page} pages={pages} start={start} shown={rows.length} total={totals.referred} busy={busy} onPage={onPage} />
      ) : null}
    </section>
  );
}

/**
 * Focusable while disabled, so a keyboard user's focus stays on the button they
 * pressed: while the next page loads, and on the last page, where Next has nothing
 * left to do.
 */
export function PageNav({
  page,
  pages,
  start,
  shown,
  total,
  busy,
  onPage,
}: {
  page: number;
  pages: number;
  /** Rows before this page. */
  start: number;
  shown: number;
  total: number;
  busy: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <nav className="text-muted-foreground mt-3 flex items-center justify-end gap-2 text-[12px]" aria-label="Pagination">
      <span className="tabular-nums" data-testid="referrals-range" aria-live="polite">
        {formatNumber(start + 1)}–{formatNumber(start + shown)} of {formatNumber(total)}
      </span>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-label="Previous page"
        disabled={busy || page <= 1}
        focusableWhenDisabled
        className={PAGE_BUTTON}
        onClick={() => onPage(page - 1)}
        data-testid="referrals-prev"
      >
        <ChevronLeftIcon />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-label="Next page"
        disabled={busy || page >= pages}
        focusableWhenDisabled
        className={PAGE_BUTTON}
        onClick={() => onPage(page + 1)}
        data-testid="referrals-next"
      >
        <ChevronRightIcon />
      </Button>
    </nav>
  );
}

/** Two lines on a phone, one row of columns from `sm`, with the status always at the end. */
function Row({ row }: { row: ReferralListRow }) {
  const status = STATUS[row.status];
  return (
    <li
      data-testid="referrals-row"
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-[var(--glass-lo)] px-4 py-3 text-[13px] sm:grid-cols-[minmax(0,1fr)_7rem_6rem_11rem]"
    >
      <span
        className={cn("col-start-1 row-start-1 truncate", row.former ? "text-muted-foreground" : "text-foreground")}
        title={row.identity}
        data-testid="referrals-identity"
      >
        {row.identity}
      </span>
      <span
        className="text-muted-foreground col-start-1 row-start-2 text-[12px] sm:col-start-2 sm:row-start-1"
        data-testid="referrals-joined"
      >
        {row.joinedOn ? formatDay(row.joinedOn) : <span aria-label="Date not kept">—</span>}
      </span>
      <span
        className="text-muted-foreground col-start-2 row-start-2 justify-self-end text-[12px] whitespace-nowrap tabular-nums sm:col-start-3 sm:row-start-1 sm:justify-self-start"
        data-testid="referrals-activity"
      >
        {row.activity === null ? (
          <span aria-label="Activity not available">—</span>
        ) : (
          <>
            {formatNumber(row.activity)} / {REFERRAL_ACTIVITY_THRESHOLD}
            <span className="sm:hidden"> activities</span>
          </>
        )}
      </span>
      <span className="col-start-2 row-start-1 flex items-center justify-end gap-2 sm:col-start-4">
        {row.amountPhp !== null ? (
          <span className="text-muted-foreground text-[12px] whitespace-nowrap tabular-nums">
            {formatNumber(row.amountPhp)} PHP
          </span>
        ) : null}
        <StatusTag tone={status.tone} data-testid="referrals-status">
          {status.label}
        </StatusTag>
      </span>
    </li>
  );
}

function Rules({ limit }: { limit: number }) {
  return (
    <section className="glass mt-2 grid gap-3 rounded-2xl px-4 py-4 sm:px-5" data-testid="referrals-rules">
      <h2 className="flex items-center gap-2 text-[15px] font-medium">
        <ScrollTextIcon className="text-muted-foreground size-4" strokeWidth={1.5} />
        How rewards work
      </h2>
      <ul className="text-muted-foreground grid list-disc gap-1.5 pl-4 text-[13px]">
        <li>
          A referral becomes eligible once the person you invited has made {REFERRAL_ACTIVITY_THRESHOLD} or more on-chain
          activities, counted from when they signed up with your link.
        </li>
        <li>You earn {REFERRAL_REWARD_PHP} PHP for each eligible referral.</li>
        <li>
          Rewards are paid manually, within {PAYOUT_WITHIN_DAYS} days of a referral being eligible and your payout
          questionnaire being complete.
        </li>
        <li>You can earn up to {rewards(limit)}. Referrals past that show as Over limit.</li>
      </ul>
    </section>
  );
}

function Figure({
  icon: Icon,
  label,
  value,
  unit,
  testId,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  unit?: string;
  testId: string;
  className?: string;
}) {
  return (
    <div className={cn("glass min-w-0 rounded-2xl px-4 py-3", className)}>
      <dt className="text-label flex items-center gap-1.5 text-[12px]">
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden />
        {label}
      </dt>
      <dd className="text-foreground/90 mt-1 flex flex-wrap items-baseline gap-x-1 tabular-nums" data-testid={testId}>
        <span className="text-xl font-medium tracking-tight [overflow-wrap:anywhere] sm:text-2xl lg:text-xl xl:text-2xl">{formatNumber(value)}</span>
        {unit ? <span className="text-label text-[12px]">{unit}</span> : null}
      </dd>
    </div>
  );
}
