import { writePayoutDetails, type PayoutDraft, type PayoutWritten } from "@/components/vault/referral-payout-client";
import { validatePayoutProfile, type PayoutFieldErrors, type PayoutSummary } from "@/lib/referral-payout";
import {
  validateTestimonial,
  type Testimonial,
  type TestimonialFieldErrors,
  type TestimonialInput,
} from "@/lib/referral-testimonial";

/*
 * The questionnaire's feedback and opt-in (WP-4.6, DOQ-28, D-113), apart from
 * React so that it can be tested without a DOM: components/vault/
 * referral-testimonial-fields.tsx draws the fields, and the payout dialog saves
 * them with the details. They go to their own route, so the payout details'
 * route and its checks stay as they are.
 */

export const TESTIMONIAL_ROUTE = "/api/referrals/testimonial";
export const TESTIMONIAL_LOAD_FAILED = "Your feedback couldn't be loaded, so it isn't shown here.";
export const TESTIMONIAL_SAVE_FAILED = "Your feedback couldn't be saved.";

export type TestimonialLoaded = { testimonial: Testimonial | null; canEdit: boolean };

/**
 * What the dialog shows for feedback: the fields, a note that they couldn't be
 * loaded, or nothing at all. Nothing is what a 404 means (the legal pages aren't
 * live) and what a 403 means (no eligible referral and nothing stored).
 */
export type TestimonialSlot = ({ kind: "ready" } & TestimonialLoaded) | { kind: "unavailable" } | { kind: "hidden" };

/** The user's own feedback, never from a cache. */
export async function readTestimonial(): Promise<TestimonialSlot> {
  try {
    const res = await fetch(TESTIMONIAL_ROUTE, { cache: "no-store" });
    if (res.status === 404 || res.status === 403) return { kind: "hidden" };
    const body = (await res.json().catch(() => null)) as (TestimonialLoaded & { error?: string }) | null;
    if (!res.ok || !body || typeof body.canEdit !== "boolean") return { kind: "unavailable" };
    return { kind: "ready", testimonial: body.testimonial ?? null, canEdit: body.canEdit };
  } catch {
    return { kind: "unavailable" };
  }
}

export type TestimonialWritten =
  | { testimonial: Testimonial | null }
  | { message: string; fields: TestimonialFieldErrors };

export async function writeTestimonial(input: TestimonialInput): Promise<TestimonialWritten> {
  try {
    const res = await fetch(TESTIMONIAL_ROUTE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => null)) as {
      testimonial?: Testimonial | null;
      error?: string;
      fields?: TestimonialFieldErrors;
    } | null;
    if (res.ok && body && body.testimonial !== undefined) return { testimonial: body.testimonial };
    return { message: body?.error || TESTIMONIAL_SAVE_FAILED, fields: body?.fields ?? {} };
  } catch {
    return { message: TESTIMONIAL_SAVE_FAILED, fields: {} };
  }
}

/** What's in the two fields. The box starts unticked unless the user ticked it before. */
export type TestimonialDraft = { feedback: string; consent: boolean };

export function testimonialDraft(testimonial: Testimonial | null): TestimonialDraft {
  return { feedback: testimonial?.feedback ?? "", consent: testimonial?.consent ?? false };
}

/** Line breaks can't be stored, so typing or pasting one gives a space instead. */
export function feedbackInput(value: string): string {
  return value.replace(/\r\n|[\r\n]/g, " ");
}

/** Whether saving would change anything: unchanged feedback isn't sent, so an approval isn't touched. */
export function testimonialChanged(saved: Testimonial | null, draft: TestimonialDraft): boolean {
  const feedback = draft.feedback.trim();
  if (!saved) return feedback !== "" || draft.consent;
  return feedback !== saved.feedback || draft.consent !== saved.consent;
}

/** One line under the box about where the saved testimonial stands, or null for none. */
export function testimonialStatusNote(saved: Testimonial | null, draft: TestimonialDraft): string | null {
  if (!saved?.consent) return null;
  if (testimonialChanged(saved, draft)) {
    return draft.consent ? "Saving sends your feedback for review again." : null;
  }
  switch (saved.status) {
    case "approved":
      return "Shown on Doqtri's home page.";
    case "pending":
      return "Waiting for review before it's shown.";
    case "rejected":
      return "Not shown on the site. Edit it to send it for review again.";
    default:
      return null;
  }
}

export type QuestionnaireErrors = PayoutFieldErrors & TestimonialFieldErrors;

export type QuestionnaireRequest = {
  draft: PayoutDraft;
  /** The details as the form opened with them, to tell whether they changed. */
  savedDraft?: PayoutDraft | null;
  /** False for an owner without an eligible referral: their details aren't sent. */
  canEditDetails: boolean;
  /** The feedback fields, when the dialog shows them. */
  testimonial: { saved: Testimonial | null; draft: TestimonialDraft } | null;
};

export type QuestionnaireOutcome =
  /** Another save is still going: this press did nothing. */
  | { kind: "busy" }
  /** The form's own check found problems; nothing was sent. */
  | { kind: "invalid"; errors: QuestionnaireErrors }
  /** Everything sent was saved. `summary` is null when the details weren't sent. */
  | { kind: "saved"; summary: PayoutSummary | null; testimonialSaved: boolean }
  /**
   * The details or the feedback were refused. `testimonialSaved` is true when a
   * withdrawal, sent first, went through all the same.
   */
  | { kind: "refused"; message: string; errors: QuestionnaireErrors; testimonialSaved: boolean }
  /** The details were saved, and the feedback wasn't. */
  | { kind: "partial"; summary: PayoutSummary; message: string; errors: QuestionnaireErrors };

/** Whether two drafts are the same details, as they would be saved. */
function sameDetails(a: PayoutDraft, b: PayoutDraft): boolean {
  const left = validatePayoutProfile(a);
  const right = validatePayoutProfile(b);
  return left.ok && right.ok && JSON.stringify(left.profile) === JSON.stringify(right.profile);
}

/**
 * Saves the questionnaire. Both parts are checked before anything is sent.
 *
 * A withdrawal (unticking the box) goes first, on its own, so nothing about the
 * details, refused or failing, can keep a testimonial on the site. The details
 * are sent when they changed, or when nothing else is being saved (a plain
 * save, as before); unchanged details aren't sent again alongside feedback.
 * Other feedback changes go after the details. One save at a time, whatever the
 * button's state says.
 */
export function createQuestionnaireSaver(
  writeDetails: (profile: Parameters<typeof writePayoutDetails>[0]) => Promise<PayoutWritten> = writePayoutDetails,
  writeFeedback: (input: TestimonialInput) => Promise<TestimonialWritten> = writeTestimonial,
) {
  let saving = false;
  return {
    get saving() {
      return saving;
    },
    async save(request: QuestionnaireRequest, onSend?: () => void): Promise<QuestionnaireOutcome> {
      if (saving) return { kind: "busy" };
      const errors: QuestionnaireErrors = {};
      const testimonial = request.testimonial;

      const feedbackChanged = testimonial ? testimonialChanged(testimonial.saved, testimonial.draft) : false;
      const withdrawing = feedbackChanged && Boolean(testimonial!.saved?.consent) && !testimonial!.draft.consent;
      const detailsChanged = !request.savedDraft || !sameDetails(request.savedDraft, request.draft);
      const sendDetails = request.canEditDetails && (detailsChanged || !feedbackChanged);

      const details = sendDetails ? validatePayoutProfile(request.draft) : null;
      if (details && !details.ok) Object.assign(errors, details.errors);
      const feedback = feedbackChanged ? validateTestimonial(testimonial!.draft) : null;
      if (feedback && !feedback.ok) Object.assign(errors, feedback.errors);

      if (Object.keys(errors).length > 0) return { kind: "invalid", errors };
      if (!details && !feedback) return { kind: "saved", summary: null, testimonialSaved: false };

      saving = true;
      onSend?.();
      try {
        let withdrawn = false;
        if (withdrawing && feedback?.ok) {
          const written = await writeFeedback(feedback.value);
          if (!("testimonial" in written)) {
            return { kind: "refused", message: written.message, errors: written.fields, testimonialSaved: false };
          }
          withdrawn = true;
        }
        let summary: PayoutSummary | null = null;
        if (details?.ok) {
          const written = await writeDetails(details.profile);
          if (!("summary" in written)) {
            return {
              kind: "refused",
              message: withdrawn ? `Your feedback is off the site. ${written.message}` : written.message,
              errors: written.fields,
              testimonialSaved: withdrawn,
            };
          }
          summary = written.summary;
        }
        if (feedback?.ok && !withdrawn) {
          const written = await writeFeedback(feedback.value);
          if (!("testimonial" in written)) {
            return summary
              ? { kind: "partial", summary, message: `Your payout details were saved. ${written.message}`, errors: written.fields }
              : { kind: "refused", message: written.message, errors: written.fields, testimonialSaved: false };
          }
        }
        return { kind: "saved", summary, testimonialSaved: Boolean(feedback?.ok) };
      } finally {
        saving = false;
      }
    },
  };
}
