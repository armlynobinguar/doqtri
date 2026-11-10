/**
 * Referral testimonials' rules (WP-4.6, DOQ-28, D-113): what feedback may be,
 * where a testimonial stands, and the shapes that leave the server. Safe in the
 * browser. The server's reads and writes are in lib/referral-testimonials-store.ts,
 * over backend/migrations/20261107140000_referral_testimonials.sql, whose checks
 * back the validator here.
 *
 * Feedback is optional, and so is showing it: a reward never depends on either.
 * Nothing is public without both the user's opt-in and an admin's approval of
 * the text as it stands, and then only the questionnaire's name and the text.
 */
import { readText, textProblem } from "@/lib/referral-payout";
import { isUuid } from "@/lib/referral-payouts";

/** In characters (code points), as Postgres's char_length counts them. The database checks the same. */
export const TESTIMONIAL_FEEDBACK_MAX = 500;
export const TESTIMONIAL_PLACEHOLDER = "I used Doqtri to map my ideas!";
export const TESTIMONIAL_CONSENT_LABEL = "Doqtri may show my feedback and name publicly.";
/** What referral_testimonials_public() returns at most, and so what the landing page shows. */
export const LANDING_TESTIMONIALS_MAX = 12;

/**
 * private: no consent, so never public. pending: consented, waiting for an admin.
 * approved: consented and approved, so public. rejected: consented, but an admin said no.
 */
export type TestimonialStatus = "private" | "pending" | "approved" | "rejected";

/** The user's own testimonial, as the questionnaire shows it. */
export type Testimonial = { feedback: string; consent: boolean; status: TestimonialStatus };

/** What a save asks for. No feedback means no testimonial: the row is deleted. */
export type TestimonialInput = { feedback: string | null; consent: boolean };

export type TestimonialField = "feedback" | "consent";
export type TestimonialFieldErrors = Partial<Record<TestimonialField, string>>;
export type TestimonialValidation = { ok: true; value: TestimonialInput } | { ok: false; errors: TestimonialFieldErrors };

const NO_FEEDBACK_TO_SHARE = "Write your feedback to share it, or untick this.";

/**
 * The payout name's rules (lib/referral-payout.ts's textProblem()): nothing
 * invisible or a control character, line breaks included, and at least one
 * letter or number. Empty is fine: feedback is optional. Consent with nothing
 * to share is refused rather than quietly dropped. Anything else in `input`,
 * such as a user_id or an approval, goes no further than this.
 */
export function validateTestimonial(input: unknown): TestimonialValidation {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const errors: TestimonialFieldErrors = {};

  const feedback = readText(raw.feedback);
  const problem = textProblem(feedback, TESTIMONIAL_FEEDBACK_MAX, null);
  if (problem) errors.feedback = problem;

  if (raw.consent !== undefined && typeof raw.consent !== "boolean") errors.consent = "Tick the box or leave it unticked.";
  const consent = raw.consent === true;
  if (consent && !feedback && !errors.feedback) errors.consent = NO_FEEDBACK_TO_SHARE;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { feedback: feedback || null, consent } };
}

/** The row's columns that say where it stands. */
export type TestimonialStateRecord = { consent: boolean; approved_at: string | null; rejected_at: string | null };

export function testimonialStatus(record: TestimonialStateRecord): TestimonialStatus {
  if (!record.consent) return "private";
  if (record.approved_at) return "approved";
  if (record.rejected_at) return "rejected";
  return "pending";
}

// ---------------------------------------------------------------------------
// The landing page
// ---------------------------------------------------------------------------

/** All the landing page gets: the questionnaire's name and the text. */
export type PublicTestimonial = { name: string; feedback: string };

/**
 * What referral_testimonials_public() returned, as the page gets it: name and
 * feedback copied out by name, so nothing else the rows might carry reaches the
 * browser (AC 3). A row missing either is left out, and so is anything past 12.
 */
export function publicTestimonials(rows: unknown): PublicTestimonial[] {
  if (!Array.isArray(rows)) return [];
  const out: PublicTestimonial[] = [];
  for (const row of rows) {
    if (out.length >= LANDING_TESTIMONIALS_MAX) break;
    const { name, feedback } = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    if (typeof name === "string" && name && typeof feedback === "string" && feedback) out.push({ name, feedback });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admin review
// ---------------------------------------------------------------------------

/** What referral_testimonials_for_review() returns. */
export type TestimonialReviewRecord = {
  user_id: string;
  name: string | null;
  feedback: string;
  consent: boolean;
  approved_at: string | null;
  rejected_at: string | null;
  updated_at: string;
};

export type TestimonialReviewRow = {
  userId: string;
  /** The questionnaire's name; null when none is saved, and then it can't appear on the site. */
  name: string | null;
  feedback: string;
  status: TestimonialStatus;
  /** The row's version: a decision names it, so text edited since can't be approved unseen. */
  version: string;
};

export function testimonialReviewRow(record: TestimonialReviewRecord): TestimonialReviewRow {
  return {
    userId: record.user_id,
    name: record.name,
    feedback: record.feedback,
    status: testimonialStatus(record),
    version: record.updated_at,
  };
}

export type TestimonialDecision = "approve" | "reject";
export type TestimonialReviewRequest = { userId: string; version: string; decision: TestimonialDecision };

/** What the admin route accepts. A version is the timestamp the list showed, sent back as it came. */
export function checkTestimonialReview(
  input: unknown,
): { ok: true; value: TestimonialReviewRequest } | { ok: false; error: string } {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const { userId, version, decision } = raw;
  if (
    !isUuid(userId) ||
    typeof version !== "string" ||
    version.length > 64 ||
    !Number.isFinite(Date.parse(version)) ||
    (decision !== "approve" && decision !== "reject")
  ) {
    return { ok: false, error: "Reload the page and try again." };
  }
  return { ok: true, value: { userId, version, decision } };
}
