import type { Outcome } from "@/components/admin/referral-payouts-client";
import type {
  TestimonialDecision,
  TestimonialReviewRequest,
  TestimonialReviewRow,
  TestimonialStatus,
} from "@/lib/referral-testimonial";

/*
 * The admin panel's testimonial review (WP-4.6, DOQ-28, D-113), apart from React
 * so that it can be tested without a DOM: components/admin/referral-testimonials.tsx
 * draws it.
 */

export const TESTIMONIALS_ROUTE = "/api/admin/referrals/testimonials";

/** The server's own words when it has some, else `fallback`. Never from a cache. */
async function call<T>(
  init: RequestInit,
  fallback: string,
  pick: (body: Record<string, unknown>) => T | undefined,
): Promise<Outcome<T>> {
  try {
    const res = await fetch(TESTIMONIALS_ROUTE, { cache: "no-store", ...init });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const value = res.ok && body ? pick(body) : undefined;
    if (value === undefined) {
      return { ok: false, message: typeof body?.error === "string" && body.error ? body.error : fallback };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, message: fallback };
  }
}

export function fetchTestimonials(): Promise<Outcome<TestimonialReviewRow[]>> {
  return call({}, "The testimonials couldn't be loaded.", (body) =>
    Array.isArray(body.rows) ? (body.rows as TestimonialReviewRow[]) : undefined,
  );
}

/** Exactly the version the row showed, so an edit made since is refused rather than decided unseen. */
export function reviewRequest(row: TestimonialReviewRow, decision: TestimonialDecision): TestimonialReviewRequest | null {
  if (!canDecide(row, decision)) return null;
  return { userId: row.userId, version: row.version, decision };
}

export function sendReview(request: TestimonialReviewRequest): Promise<Outcome<"approved" | "rejected">> {
  return call(
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) },
    "The testimonial couldn't be changed. Reload to see it as it is now.",
    (body) => (body.status === "approved" || body.status === "rejected" ? body.status : undefined),
  );
}

/** Private feedback is never decided on; otherwise any decision but the one it already has. */
export function canDecide(row: TestimonialReviewRow, decision: TestimonialDecision): boolean {
  if (row.status === "private") return false;
  return decision === "approve" ? row.status !== "approved" : row.status !== "rejected";
}

export const TESTIMONIAL_STATUS_LABEL: Record<TestimonialStatus, string> = {
  pending: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  private: "Private",
};

export function reviewedMessage(row: TestimonialReviewRow, status: "approved" | "rejected"): string {
  const who = row.name ?? "this referrer";
  if (status === "rejected") return `Rejected ${who}'s testimonial. It isn't shown on the site.`;
  return row.name
    ? `Approved ${who}'s testimonial. It shows on the landing page once the legal pages are live.`
    : "Approved. It won't show on the site until the referrer saves a name in their payout details.";
}
