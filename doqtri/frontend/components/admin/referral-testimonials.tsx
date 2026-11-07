"use client";

import { useRef, useState } from "react";
import { CircleAlertIcon, CircleCheckIcon, Loader2Icon, RotateCwIcon, ThumbsDownIcon, ThumbsUpIcon, XIcon } from "lucide-react";
import { createSingleFlight } from "@/components/admin/referral-payouts-client";
import {
  TESTIMONIAL_STATUS_LABEL,
  canDecide,
  fetchTestimonials,
  reviewRequest,
  reviewedMessage,
  sendReview,
} from "@/components/admin/referral-testimonials-client";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import type { TestimonialDecision, TestimonialReviewRow, TestimonialStatus } from "@/lib/referral-testimonial";
import { cn } from "@/lib/utils";

type Notice = { tone: "ok" | "error"; text: string };

const STATUS_TONE: Record<TestimonialStatus, "planned" | "verified" | "warning" | "danger"> = {
  pending: "warning",
  approved: "verified",
  rejected: "danger",
  private: "planned",
};

/**
 * Referral testimonials for review (WP-4.6, DOQ-28, D-113), on the payouts
 * panel. Feedback the referrer opted in to show can be approved or rejected;
 * private feedback is listed for admins to read, never to publish. Approving
 * shows nothing publicly until the legal pages are live. `initialRows` is null
 * when the server couldn't read them.
 */
export function ReferralTestimonials({ initialRows }: { initialRows: TestimonialReviewRow[] | null }) {
  const [rows, setRows] = useState(initialRows);
  const [notice, setNotice] = useState<Notice | null>(
    initialRows ? null : { tone: "error", text: "The testimonials couldn't be loaded." },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const flight = useRef(createSingleFlight());

  async function reload(): Promise<boolean> {
    const result = await fetchTestimonials();
    if (result.ok) setRows(result.value);
    return result.ok;
  }

  function decide(row: TestimonialReviewRow, decision: TestimonialDecision) {
    const request = reviewRequest(row, decision);
    if (!request) return;
    void flight.current.run(async () => {
      setBusy(`${row.userId}:${decision}`);
      try {
        const result = await sendReview(request);
        const fresh = await reload();
        if (result.ok) setNotice({ tone: "ok", text: reviewedMessage(row, result.value) });
        else setNotice({ tone: "error", text: fresh ? result.message : `${result.message} What's shown may be out of date.` });
      } finally {
        setBusy(null);
      }
    });
  }

  const waiting = rows?.filter((row) => row.status === "pending").length ?? 0;

  return (
    <section className="mt-14" aria-labelledby="testimonials-heading" data-testid="testimonials-admin">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="testimonials-heading" className="display text-2xl">
          Testimonials
        </h2>
        {rows ? (
          <p className="text-muted-foreground text-[13px]" data-testid="testimonials-waiting">
            {waiting} waiting for review
          </p>
        ) : null}
      </div>
      <p className="text-muted-foreground mt-3 text-[14px]">
        Feedback from the payout questionnaire. Only feedback the referrer chose to show, and you approve, appears on
        the landing page, as their name and words, once the legal pages are live. An edit, or a new name, sends it back
        for review.
      </p>

      <div aria-live="polite" className="mt-4 empty:hidden">
        {notice ? (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            data-testid="testimonials-notice"
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

      {rows === null ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-4"
          disabled={busy !== null}
          onClick={() =>
            void flight.current.run(async () => {
              setBusy("reload");
              try {
                if (await reload()) setNotice(null);
              } finally {
                setBusy(null);
              }
            })
          }
          data-testid="testimonials-retry"
        >
          <RotateCwIcon strokeWidth={1.5} />
          Try again
        </Button>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground mt-8 text-center text-[14px]" data-testid="testimonials-empty">
          No feedback yet.
        </p>
      ) : (
        <ul className="mt-5 grid gap-4">
          {rows.map((row) => (
            <TestimonialRow key={row.userId} row={row} busy={busy} onDecide={(decision) => decide(row, decision)} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function TestimonialRow({
  row,
  busy,
  onDecide,
}: {
  row: TestimonialReviewRow;
  busy: string | null;
  onDecide: (decision: TestimonialDecision) => void;
}) {
  const working = (decision: TestimonialDecision) => busy === `${row.userId}:${decision}`;
  return (
    <li className="glass min-w-0 rounded-2xl px-4 py-4 sm:px-5" data-testid="testimonial-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p
          className={cn("min-w-0 text-[14px] font-medium [overflow-wrap:anywhere]", !row.name && "text-muted-foreground")}
          data-testid="testimonial-name"
          dir="auto"
        >
          {row.name ?? "No name saved"}
        </p>
        <StatusTag tone={STATUS_TONE[row.status]} data-testid="testimonial-state">
          {TESTIMONIAL_STATUS_LABEL[row.status]}
        </StatusTag>
      </div>

      <p className="mt-2 text-[13px] leading-relaxed [overflow-wrap:anywhere]" data-testid="testimonial-text" dir="auto">
        {row.feedback}
      </p>

      {row.status === "private" ? (
        <p className="text-muted-foreground mt-3 text-[12px]" data-testid="testimonial-private">
          Private feedback: the referrer didn&apos;t agree to show it, so it can&apos;t be published.
        </p>
      ) : (
        <>
          {!row.name ? (
            <p className="text-muted-foreground mt-3 text-[12px]" data-testid="testimonial-no-name">
              No name in their payout details yet, so it can&apos;t be approved: there&apos;s no name to approve it
              under. It can be once they save one.
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canDecide(row, "approve") || busy !== null}
              onClick={() => onDecide("approve")}
              title={row.name ? undefined : "No name to approve it under yet"}
              data-testid="testimonial-approve"
            >
              {working("approve") ? (
                <Loader2Icon className="animate-spin" strokeWidth={1.5} />
              ) : (
                <ThumbsUpIcon strokeWidth={1.5} />
              )}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canDecide(row, "reject") || busy !== null}
              onClick={() => onDecide("reject")}
              data-testid="testimonial-reject"
            >
              {working("reject") ? (
                <Loader2Icon className="animate-spin" strokeWidth={1.5} />
              ) : (
                <ThumbsDownIcon strokeWidth={1.5} />
              )}
              Reject
            </Button>
          </div>
        </>
      )}
    </li>
  );
}
