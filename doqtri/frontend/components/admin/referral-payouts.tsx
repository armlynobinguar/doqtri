"use client";

import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import {
  BanknoteIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  GaugeIcon,
  Loader2Icon,
  RotateCcwIcon,
  RotateCwIcon,
  BanIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StatusTag } from "@/components/ui/status-tag";
import { Textarea } from "@/components/ui/textarea";
import {
  STATUS_LABEL,
  createSingleFlight,
  fetchQueue,
  fetchReferrals,
  formatDay,
  formatPhp,
  formatTime,
  limitMessage,
  markPaid,
  markPaidRequest,
  paidMessage,
  restoreMessage,
  restoreReward,
  setLimit,
  voidMessage,
  voidReward,
  type Outcome,
} from "@/components/admin/referral-payouts-client";
import {
  PAYOUT_REFERENCE_MAX,
  REWARD_LIMIT_MAX,
  VOID_REASON_MAX,
  checkLimit,
  checkReference,
  checkVoidReason,
  payoutDestination,
  type PayoutDue,
  type PayoutQueueRow,
  type PayoutReferralRow,
  type RewardStatus,
} from "@/lib/referral-payouts";
import { cn } from "@/lib/utils";

type Notice = { tone: "ok" | "error"; text: string };
type Review = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; rows: PayoutReferralRow[] };
type Pending =
  | { kind: "pay"; row: PayoutQueueRow }
  | { kind: "limit"; row: PayoutQueueRow }
  | { kind: "void"; row: PayoutQueueRow; referral: PayoutReferralRow };

const STATUS_TONE: Record<RewardStatus, "planned" | "verified" | "info" | "warning" | "danger"> = {
  pending: "planned",
  eligible: "info",
  over_limit: "warning",
  paid: "verified",
  void: "danger",
};

/**
 * The payout queue (WP-4.6, DOQ-26): who is owed what, where to send it, by when,
 * and the actions. Payout details show in full here and nowhere else. Every
 * action goes through one single-flight guard, so a double press sends once.
 */
export function ReferralPayouts({ initialRows }: { initialRows: PayoutQueueRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const flight = useRef(createSingleFlight());

  const loadReview = useCallback(async (referrerId: string) => {
    setReviews((all) => ({ ...all, [referrerId]: all[referrerId]?.state === "ready" ? all[referrerId] : { state: "loading" } }));
    const result = await fetchReferrals(referrerId);
    setReviews((all) => ({
      ...all,
      [referrerId]: result.ok ? { state: "ready", rows: result.value } : { state: "error", message: result.message },
    }));
  }, []);

  /** The queue again, and the open review of `referrerId`; the refreshed row, if it's still there. */
  const refresh = useCallback(
    async (referrerId?: string): Promise<PayoutQueueRow | undefined> => {
      const [queue] = await Promise.all([
        fetchQueue(),
        referrerId && expanded.has(referrerId) ? loadReview(referrerId) : Promise.resolve(),
      ]);
      if (!queue.ok) {
        setNotice({ tone: "error", text: `${queue.message} What's shown may be out of date.` });
        return undefined;
      }
      setRows(queue.value);
      return queue.value.find((row) => row.referrerId === referrerId);
    },
    [expanded, loadReview],
  );

  function toggle(referrerId: string) {
    const next = new Set(expanded);
    if (next.has(referrerId)) next.delete(referrerId);
    else {
      next.add(referrerId);
      void loadReview(referrerId);
    }
    setExpanded(next);
  }

  /** Runs one action: busy while it runs, its message after, and the row refreshed either way. */
  async function act<T>(
    key: string,
    referrerId: string,
    action: () => Promise<Outcome<T>>,
    describe: (value: T, refreshed: PayoutQueueRow | undefined) => string,
    inDialog: boolean,
  ) {
    await flight.current.run(async () => {
      setBusy(key);
      setDialogError(null);
      try {
        const result = await action();
        const refreshed = await refresh(referrerId);
        if (result.ok) {
          setPending(null);
          setNotice({ tone: "ok", text: describe(result.value, refreshed) });
        } else if (inDialog) {
          setDialogError(result.message);
        } else {
          setNotice({ tone: "error", text: result.message });
        }
      } finally {
        setBusy(null);
      }
    });
  }

  const totalOwed = rows.reduce((sum, row) => sum + row.owedPhp, 0);
  const overdue = rows.filter((row) => row.due.state === "due" && row.due.overdue).length;
  const waiting = rows.filter((row) => row.due.state === "waiting_for_details").length;

  return (
    <>
      <section className="glass mt-6 grid grid-cols-2 gap-x-8 gap-y-3 rounded-2xl px-5 py-5 sm:grid-cols-4" data-testid="payouts-summary">
        <Figure label="Owed" value={formatPhp(totalOwed)} testId="payouts-total-owed" />
        <Figure label="Referrers" value={String(rows.length)} testId="payouts-total-referrers" />
        <Figure label="Overdue" value={String(overdue)} tone={overdue > 0 ? "danger" : undefined} testId="payouts-total-overdue" />
        <Figure label="Waiting for details" value={String(waiting)} testId="payouts-total-waiting" />
      </section>

      <p className="text-muted-foreground mt-4 text-[13px]" data-testid="payouts-manual-note">
        Nothing is sent automatically. Send each payout yourself, then mark it as paid here. For XLM, send the PHP
        equivalent at that day&apos;s rate and paste the transaction hash as the reference. A payout is due 30 days after
        the earliest unpaid reward qualified or the referrer first saved their details, whichever is later.
      </p>

      <div aria-live="polite" className="mt-4 empty:hidden">
        {notice ? (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            data-testid="payouts-notice"
            className={cn(
              "flex items-start gap-2 rounded-xl border px-3 py-2 text-[13px]",
              notice.tone === "error"
                ? "border-destructive/40 text-destructive"
                : "border-[var(--glass-lo)] bg-[var(--glass)]",
            )}
          >
            {notice.tone === "error" ? (
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
            ) : (
              <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-[var(--success)]" strokeWidth={1.5} />
            )}
            <span className="min-w-0 flex-1 break-words">{notice.text}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground shrink-0"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              <XIcon className="size-4" strokeWidth={1.5} />
            </button>
          </p>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-10 text-center text-[14px]" data-testid="payouts-empty">
          Nobody is owed anything, and no reward is waiting over a limit or void.
        </p>
      ) : (
        <ul className="mt-5 grid gap-4">
          {rows.map((row) => (
            <QueueRow
              key={row.referrerId}
              row={row}
              busy={busy}
              open={expanded.has(row.referrerId)}
              review={reviews[row.referrerId]}
              onToggle={() => toggle(row.referrerId)}
              onRetryReview={() => void loadReview(row.referrerId)}
              onPay={() => {
                setDialogError(null);
                setPending({ kind: "pay", row });
              }}
              onLimit={() => {
                setDialogError(null);
                setPending({ kind: "limit", row });
              }}
              onVoid={(referral) => {
                setDialogError(null);
                setPending({ kind: "void", row, referral });
              }}
              onRestore={(referral) =>
                void act(
                  `restore:${referral.rewardId}`,
                  row.referrerId,
                  () => restoreReward(referral.rewardId!),
                  (status) => restoreMessage(referral.identity, status),
                  false,
                )
              }
            />
          ))}
        </ul>
      )}

      <MarkPaidDialog
        key={pending?.kind === "pay" ? `pay:${pending.row.referrerId}` : "pay"}
        row={pending?.kind === "pay" ? pending.row : null}
        busy={busy === "pay"}
        error={dialogError}
        onClose={() => setPending(null)}
        onConfirm={(row, reference) => {
          const request = markPaidRequest(row, reference);
          if (!request) return;
          void act("pay", row.referrerId, () => markPaid(request), (paid) => paidMessage(row.identity, paid), true);
        }}
      />
      <LimitDialog
        key={pending?.kind === "limit" ? `limit:${pending.row.referrerId}` : "limit"}
        row={pending?.kind === "limit" ? pending.row : null}
        busy={busy === "limit"}
        error={dialogError}
        onClose={() => setPending(null)}
        onConfirm={(row, limit) =>
          void act(
            "limit",
            row.referrerId,
            () => setLimit(row.referrerId, limit),
            (set, refreshed) => limitMessage(row.identity, set, row, refreshed),
            true,
          )
        }
      />
      <VoidDialog
        key={pending?.kind === "void" ? `void:${pending.referral.rewardId}` : "void"}
        pending={pending?.kind === "void" ? pending : null}
        busy={busy === "void"}
        error={dialogError}
        onClose={() => setPending(null)}
        onConfirm={(row, referral, reason) =>
          void act(
            "void",
            row.referrerId,
            () => voidReward(referral.rewardId!, reason),
            () => voidMessage(referral.identity),
            true,
          )
        }
      />
    </>
  );
}

function Figure({ label, value, tone, testId }: { label: string; value: string; tone?: "danger"; testId: string }) {
  return (
    <div className="min-w-0">
      <p className={cn("display text-2xl tabular-nums", tone === "danger" && "text-destructive")} data-testid={testId}>
        {value}
      </p>
      <p className="text-muted-foreground mt-0.5 text-[12px]">{label}</p>
    </div>
  );
}

function DueTag({ due }: { due: PayoutDue }) {
  if (due.state === "due") {
    return due.overdue ? (
      <StatusTag tone="danger" data-testid="payout-due">
        Overdue · due {formatDay(due.dueAt)}
      </StatusTag>
    ) : (
      <StatusTag tone="info" data-testid="payout-due">
        Due {formatDay(due.dueAt)}
      </StatusTag>
    );
  }
  return (
    <StatusTag tone={due.state === "waiting_for_details" ? "warning" : "planned"} data-testid="payout-due">
      {due.state === "waiting_for_details" ? "Waiting for details" : "Nothing owed"}
    </StatusTag>
  );
}

function QueueRow({
  row,
  busy,
  open,
  review,
  onToggle,
  onRetryReview,
  onPay,
  onLimit,
  onVoid,
  onRestore,
}: {
  row: PayoutQueueRow;
  busy: string | null;
  open: boolean;
  review: Review | undefined;
  onToggle: () => void;
  onRetryReview: () => void;
  onPay: () => void;
  onLimit: () => void;
  onVoid: (referral: PayoutReferralRow) => void;
  onRestore: (referral: PayoutReferralRow) => void;
}) {
  const reviewId = useId();
  const payable = Boolean(row.details) && row.eligibleCount > 0;
  return (
    <li className="glass min-w-0 rounded-2xl px-4 py-4 sm:px-5" data-testid="payout-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-mono text-[12px] break-all" data-testid="payout-identity">
          {row.identity}
        </p>
        <DueTag due={row.due} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-6">
        <Stat label="Owed" value={formatPhp(row.owedPhp)} testId="payout-owed" strong />
        <Stat label="Eligible" value={String(row.eligibleCount)} testId="payout-eligible" />
        <Stat label="Over limit" value={String(row.overLimitCount)} testId="payout-over-limit" />
        <Stat label="Paid" value={String(row.paidCount)} testId="payout-paid" />
        <Stat label="Void" value={String(row.voidCount)} testId="payout-void" />
        <Stat
          label="Limit"
          value={`${row.limit}${row.limitRaised ? "" : " (default)"}`}
          testId="payout-limit"
        />
      </dl>

      <PayoutDetailsBlock row={row} />

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!payable || busy !== null}
          onClick={onPay}
          data-testid="payout-mark-paid"
          title={payable ? undefined : row.details ? "Nothing eligible to pay" : "Waiting for payout details"}
        >
          <BanknoteIcon strokeWidth={1.5} />
          Mark as paid
        </Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={onLimit} data-testid="payout-set-limit">
          <GaugeIcon strokeWidth={1.5} />
          Set limit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={reviewId}
          onClick={onToggle}
          data-testid="payout-review-toggle"
        >
          {open ? <ChevronUpIcon strokeWidth={1.5} /> : <ChevronDownIcon strokeWidth={1.5} />}
          {open ? "Hide referrals" : "Review referrals"}
        </Button>
      </div>

      {open ? (
        <div id={reviewId} className="mt-4 border-t border-[var(--glass-lo)] pt-3" data-testid="payout-review">
          <ReviewList review={review} busy={busy} onRetry={onRetryReview} onVoid={onVoid} onRestore={onRestore} />
        </div>
      ) : null}
    </li>
  );
}

function Stat({ label, value, testId, strong }: { label: string; value: string; testId: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-[11px] tracking-wide uppercase">{label}</dt>
      <dd className={cn("tabular-nums", strong && "font-semibold")} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** The details in full: the one place they're shown. */
function PayoutDetailsBlock({ row }: { row: PayoutQueueRow }) {
  if (!row.details) {
    return (
      <p className="text-muted-foreground mt-3 text-[13px]" data-testid="payout-details">
        Waiting for details: the referrer hasn&apos;t filled in the payout questionnaire, so this can&apos;t be paid yet
        and no due date applies.
      </p>
    );
  }
  const { profile, savedAt, updatedAt } = row.details;
  return (
    <dl
      className="mt-3 grid gap-x-6 gap-y-1.5 rounded-xl border border-[var(--glass-lo)] px-3 py-2.5 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)]"
      data-testid="payout-details"
    >
      <Detail label="Method" value={profile.method === "xlm" ? "XLM" : `E-wallet or bank · ${profile.provider}`} />
      <Detail label="Name" value={profile.name} />
      {profile.method === "xlm" ? (
        <>
          <Detail label="Address" value={profile.address} mono />
          <Detail
            label="Memo"
            value={profile.memo ? `${profile.memo} (${profile.memoType === "id" ? "ID" : "text"})` : "None"}
            mono={Boolean(profile.memo)}
          />
        </>
      ) : (
        <>
          <Detail label="Account name" value={profile.accountName} />
          <Detail label="Account number" value={profile.accountNumber} mono />
          {profile.details ? <Detail label="Other details" value={profile.details} /> : null}
        </>
      )}
      <Detail
        label="Saved"
        value={updatedAt === savedAt ? formatDay(savedAt) : `${formatDay(savedAt)}, edited ${formatDay(updatedAt)}`}
      />
    </dl>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-label text-[11px] tracking-wide uppercase sm:pt-0.5">{label}</dt>
      <dd className={cn("min-w-0 break-all", mono && "font-mono text-[12px]")}>{value}</dd>
    </>
  );
}

function ReviewList({
  review,
  busy,
  onRetry,
  onVoid,
  onRestore,
}: {
  review: Review | undefined;
  busy: string | null;
  onRetry: () => void;
  onVoid: (referral: PayoutReferralRow) => void;
  onRestore: (referral: PayoutReferralRow) => void;
}) {
  if (!review || review.state === "loading") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-[13px]" role="status">
        <Loader2Icon className="size-4 animate-spin" strokeWidth={1.5} />
        Loading referrals…
      </p>
    );
  }
  if (review.state === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-destructive text-[13px]">
          {review.message}
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCwIcon strokeWidth={1.5} />
          Try again
        </Button>
      </div>
    );
  }
  if (review.rows.length === 0) return <p className="text-muted-foreground text-[13px]">No referrals.</p>;
  return (
    <ul className="grid gap-2">
      {review.rows.map((referral, index) => (
        <li
          key={referral.rewardId ?? `${referral.identity}-${index}`}
          className="grid gap-x-6 gap-y-1 rounded-xl border border-[var(--glass-lo)] px-3 py-2.5 text-[12px] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]"
          data-testid="payout-referral"
        >
          <div className="min-w-0">
            <p className="font-mono break-all" data-testid="payout-referral-identity">
              {referral.identity}
            </p>
            {referral.wallets
              .filter((wallet) => wallet !== referral.identity)
              .map((wallet) => (
                <p key={wallet} className="text-muted-foreground font-mono text-[11px] break-all">
                  {wallet}
                </p>
              ))}
          </div>
          <dl className="text-muted-foreground grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            <dt>Signed up</dt>
            <dd className="text-foreground">{formatTime(referral.signedUpAt)}</dd>
            <dt>Activity</dt>
            <dd className="text-foreground" data-testid="payout-referral-activity">
              {referral.activity ?? "—"}
              {referral.network ? <span className="text-label"> · {referral.network}</span> : null}
            </dd>
            <dt>Qualified</dt>
            <dd className="text-foreground">{formatTime(referral.qualifiedAt)}</dd>
            {referral.voidReason ? (
              <>
                <dt>Reason</dt>
                <dd className="text-foreground break-words">{referral.voidReason}</dd>
              </>
            ) : null}
          </dl>
          <div className="flex flex-wrap items-start gap-2 sm:flex-col sm:items-end">
            <StatusTag tone={STATUS_TONE[referral.status]} data-testid="payout-referral-status">
              {STATUS_LABEL[referral.status]}
              {referral.amountPhp !== null && referral.status !== "pending" && referral.status !== "void"
                ? ` · ${formatPhp(referral.amountPhp)}`
                : ""}
            </StatusTag>
            {referral.canVoid ? (
              <Button
                size="xs"
                variant="destructive"
                disabled={busy !== null}
                onClick={() => onVoid(referral)}
                data-testid="payout-referral-void"
              >
                <BanIcon strokeWidth={1.5} />
                Void
              </Button>
            ) : null}
            {referral.canRestore ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => onRestore(referral)}
                data-testid="payout-referral-restore"
              >
                {busy === `restore:${referral.rewardId}` ? (
                  <Loader2Icon className="animate-spin" strokeWidth={1.5} />
                ) : (
                  <RotateCcwIcon strokeWidth={1.5} />
                )}
                Restore
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A dialog that can't be closed while its action runs. */
function ActionDialog({
  open,
  busy,
  onClose,
  title,
  description,
  testId,
  children,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  title: ReactNode;
  description: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[520px]" data-testid={testId}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function DialogError({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-destructive text-[13px]" data-testid="payout-dialog-error">
      {error}
    </p>
  ) : null;
}

function ConfirmFooter({
  busy,
  onClose,
  label,
  busyLabel,
  destructive,
  testId,
}: {
  busy: boolean;
  onClose: () => void;
  label: string;
  busyLabel: string;
  destructive?: boolean;
  testId: string;
}) {
  return (
    <DialogFooter>
      <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button
        type="submit"
        variant={destructive ? "destructive" : "default"}
        disabled={busy}
        focusableWhenDisabled
        data-testid={testId}
      >
        {busy ? <Loader2Icon className="animate-spin" strokeWidth={1.5} /> : null}
        {busy ? busyLabel : label}
      </Button>
    </DialogFooter>
  );
}

function MarkPaidDialog({
  row,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  row: PayoutQueueRow | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (row: PayoutQueueRow, reference: string) => void;
}) {
  const [reference, setReference] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const details = row?.details;
  return (
    <ActionDialog
      open={Boolean(row && details)}
      busy={busy}
      onClose={() => {
        setReference("");
        setProblem(null);
        onClose();
      }}
      title={
        <>
          <BanknoteIcon className="size-4" strokeWidth={1.5} />
          Mark as paid
        </>
      }
      description="Record a payout you've already sent by hand. Nothing is sent from here."
      testId="payout-pay-dialog"
    >
      {row && details ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const checked = checkReference(reference);
            if (!checked.ok) {
              setProblem(checked.error);
              return;
            }
            setProblem(null);
            onConfirm(row, reference);
          }}
        >
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]" data-testid="payout-pay-summary">
            <dt className="text-muted-foreground">To</dt>
            <dd className="font-mono text-[12px] break-all">{row.identity}</dd>
            <dt className="text-muted-foreground">Rewards</dt>
            <dd data-testid="payout-pay-count">{row.eligibleCount}</dd>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="font-semibold" data-testid="payout-pay-amount">
              {formatPhp(row.owedPhp)}
            </dd>
            <dt className="text-muted-foreground">Method</dt>
            <dd>{details.profile.method === "xlm" ? "XLM" : details.profile.provider}</dd>
            <dt className="text-muted-foreground">Name</dt>
            <dd className="break-words">{details.profile.name}</dd>
            <dt className="text-muted-foreground">Destination</dt>
            <dd className="font-mono text-[12px] break-all" data-testid="payout-pay-destination">
              {payoutDestination(details.profile)}
            </dd>
          </dl>
          <p className="text-muted-foreground text-[12px]">
            {details.profile.method === "xlm"
              ? `Send the PHP equivalent of ${formatPhp(row.owedPhp)} in XLM at today's rate, then paste the transaction hash below.`
              : "Paste the e-wallet or bank reference number below."}
          </p>
          <div className="grid gap-1.5">
            <label htmlFor={id} className="text-[13px] font-medium">
              Reference <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Input
              id={id}
              value={reference}
              maxLength={PAYOUT_REFERENCE_MAX * 2}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problem ? true : undefined}
              onChange={(event) => setReference(event.target.value)}
              className="font-mono text-base sm:text-[13px]"
              data-testid="payout-pay-reference"
            />
            {problem ? (
              <p role="alert" className="text-destructive text-[12px]">
                {problem}
              </p>
            ) : null}
          </div>
          <DialogError error={error} />
          <ConfirmFooter
            busy={busy}
            onClose={() => {
              setReference("");
              setProblem(null);
              onClose();
            }}
            label={`Mark ${row.eligibleCount} as paid`}
            busyLabel="Recording…"
            testId="payout-pay-confirm"
          />
        </form>
      ) : null}
    </ActionDialog>
  );
}

function LimitDialog({
  row,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  row: PayoutQueueRow | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (row: PayoutQueueRow, limit: number) => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const shown = value ?? (row ? String(row.limit) : "");
  const close = () => {
    setValue(null);
    setProblem(null);
    onClose();
  };
  return (
    <ActionDialog
      open={Boolean(row)}
      busy={busy}
      onClose={close}
      title={
        <>
          <GaugeIcon className="size-4" strokeWidth={1.5} />
          Set limit
        </>
      }
      description="How many rewards this referrer can have eligible or paid, after they've emailed team@doqtri.xyz for more."
      testId="payout-limit-dialog"
    >
      {row ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const checked = checkLimit(shown);
            if (!checked.ok) {
              setProblem(checked.error);
              return;
            }
            setProblem(null);
            onConfirm(row, checked.limit);
          }}
        >
          <p className="font-mono text-[12px] break-all">{row.identity}</p>
          <ul className="text-muted-foreground list-disc pl-5 text-[12px]">
            <li>
              Now {row.limit}
              {row.limitRaised ? "" : " (the default)"}, with {row.eligibleCount + row.paidCount} eligible or paid and{" "}
              {row.overLimitCount} over the limit.
            </li>
            <li>Raising it moves the oldest over-limit rewards up to eligible, one per new place.</li>
            <li>Lowering it never changes a reward that&apos;s already eligible or paid; it only applies to later ones.</li>
          </ul>
          <div className="grid gap-1.5">
            <label htmlFor={id} className="text-[13px] font-medium">
              New limit
            </label>
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={0}
              max={REWARD_LIMIT_MAX}
              step={1}
              value={shown}
              aria-invalid={problem ? true : undefined}
              onChange={(event) => setValue(event.target.value)}
              className="w-32 text-base sm:text-[13px]"
              data-testid="payout-limit-input"
            />
            {problem ? (
              <p role="alert" className="text-destructive text-[12px]">
                {problem}
              </p>
            ) : null}
          </div>
          <DialogError error={error} />
          <ConfirmFooter busy={busy} onClose={close} label="Set limit" busyLabel="Saving…" testId="payout-limit-confirm" />
        </form>
      ) : null}
    </ActionDialog>
  );
}

function VoidDialog({
  pending,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  pending: { row: PayoutQueueRow; referral: PayoutReferralRow } | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (row: PayoutQueueRow, referral: PayoutReferralRow, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const close = () => {
    setReason("");
    setProblem(null);
    onClose();
  };
  return (
    <ActionDialog
      open={Boolean(pending)}
      busy={busy}
      onClose={close}
      title={
        <>
          <BanIcon className="size-4" strokeWidth={1.5} />
          Void reward
        </>
      }
      description="The reward stops counting and frees a place under the limit, which the oldest over-limit reward takes."
      testId="payout-void-dialog"
    >
      {pending ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const checked = checkVoidReason(reason);
            if (!checked.ok) {
              setProblem(checked.error);
              return;
            }
            setProblem(null);
            onConfirm(pending.row, pending.referral, checked.reason);
          }}
        >
          <p className="text-[13px]">
            <span className="text-muted-foreground">Referred account </span>
            <span className="font-mono text-[12px] break-all">{pending.referral.identity}</span>
            <span className="text-muted-foreground">, referred by </span>
            <span className="font-mono text-[12px] break-all">{pending.row.identity}</span>
          </p>
          <div className="grid gap-1.5">
            <label htmlFor={id} className="text-[13px] font-medium">
              Reason <span className="text-destructive">*</span>
            </label>
            <Textarea
              id={id}
              value={reason}
              maxLength={VOID_REASON_MAX * 2}
              // Checked on submit, so the message is ours and says what's wrong.
              aria-required
              aria-invalid={problem ? true : undefined}
              onChange={(event) => setReason(event.target.value)}
              className="text-base sm:text-[13px]"
              placeholder="For example: the same person signed up several accounts."
              data-testid="payout-void-reason"
            />
            {problem ? (
              <p role="alert" className="text-destructive text-[12px]">
                {problem}
              </p>
            ) : null}
          </div>
          <DialogError error={error} />
          <ConfirmFooter
            busy={busy}
            onClose={close}
            label="Void reward"
            busyLabel="Voiding…"
            destructive
            testId="payout-void-confirm"
          />
        </form>
      ) : null}
    </ActionDialog>
  );
}
