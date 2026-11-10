"use client";

import { Textarea } from "@/components/ui/textarea";
import {
  feedbackInput,
  testimonialStatusNote,
  type TestimonialDraft,
} from "@/components/vault/referral-testimonial-client";
import {
  TESTIMONIAL_CONSENT_LABEL,
  TESTIMONIAL_FEEDBACK_MAX,
  TESTIMONIAL_PLACEHOLDER,
  type Testimonial,
  type TestimonialFieldErrors,
} from "@/lib/referral-testimonial";

/**
 * The questionnaire's feedback and opt-in (WP-4.6, DOQ-28, D-113): optional
 * text, and a separate box, unticked unless the user ticked it before. Neither
 * affects a reward. Drawn only when the feedback route answered, which it does
 * only once the legal pages are live.
 */
export function TestimonialFields({
  idPrefix,
  saved,
  draft,
  canEdit,
  saving,
  errors,
  onChange,
}: {
  /** The form's own prefix, so that `${idPrefix}-feedback` and `${idPrefix}-consent` are where it sends focus. */
  idPrefix: string;
  saved: Testimonial | null;
  draft: TestimonialDraft;
  /** False without an eligible referral: the words can't change, but consent can still be withdrawn. */
  canEdit: boolean;
  saving: boolean;
  errors: TestimonialFieldErrors;
  onChange: (draft: TestimonialDraft) => void;
}) {
  const feedbackId = `${idPrefix}-feedback`;
  const consentId = `${idPrefix}-consent`;
  const describe = (id: string, error?: string) => [`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(" ");
  const length = Array.from(draft.feedback.trim()).length;
  const note = testimonialStatusNote(saved, draft);
  // Withdrawing is always possible; opting in needs an eligible referral.
  const consentLocked = saving || (!canEdit && !draft.consent);

  return (
    <div
      className="grid min-w-0 gap-3 border-t border-[var(--glass-lo)] pt-4"
      role="group"
      aria-labelledby={`${idPrefix}-testimonial-heading`}
      data-testid="testimonial-fields"
    >
      <p id={`${idPrefix}-testimonial-heading`} className="text-foreground text-[13px] font-medium">
        Your feedback
      </p>

      <div className="grid min-w-0 gap-1">
        <label htmlFor={feedbackId} className="text-muted-foreground text-[12px]">
          Feedback<span className="text-label"> (optional)</span>
        </label>
        <Textarea
          id={feedbackId}
          value={draft.feedback}
          onChange={(event) => onChange({ ...draft, feedback: feedbackInput(event.target.value) })}
          placeholder={TESTIMONIAL_PLACEHOLDER}
          rows={3}
          disabled={saving}
          readOnly={!canEdit}
          autoComplete="off"
          aria-invalid={errors.feedback ? true : undefined}
          aria-describedby={describe(feedbackId, errors.feedback)}
          className="max-h-48 min-w-0 break-words"
          data-testid="testimonial-feedback"
        />
        <p
          id={`${feedbackId}-hint`}
          className={length > TESTIMONIAL_FEEDBACK_MAX ? "text-destructive text-[12px]" : "text-label text-[12px]"}
        >
          {length}/{TESTIMONIAL_FEEDBACK_MAX} characters. How has Doqtri helped you? Your reward doesn&apos;t depend on
          it.
        </p>
        <FieldError id={`${feedbackId}-error`} message={errors.feedback} />
      </div>

      <div className="grid min-w-0 gap-1">
        <label
          htmlFor={consentId}
          className="has-[:disabled]:text-muted-foreground flex cursor-pointer items-start gap-2.5 text-[13px] has-[:disabled]:cursor-not-allowed"
        >
          <input
            id={consentId}
            type="checkbox"
            className="accent-primary mt-0.5 size-4 shrink-0"
            checked={draft.consent}
            disabled={consentLocked}
            onChange={(event) => onChange({ ...draft, consent: event.target.checked })}
            aria-invalid={errors.consent ? true : undefined}
            aria-describedby={describe(consentId, errors.consent)}
            data-testid="testimonial-consent"
          />
          <span>{TESTIMONIAL_CONSENT_LABEL}</span>
        </label>
        <p id={`${consentId}-hint`} className="text-label pl-6.5 text-[12px]" data-testid="testimonial-consent-hint">
          Optional, and your reward never depends on it. The name shown is the name in this form. An admin reviews it
          first, and again after any edit. Untick this, or delete your account, and it comes off the site.
        </p>
        {note ? (
          <p className="text-muted-foreground pl-6.5 text-[12px]" data-testid="testimonial-status">
            {note}
          </p>
        ) : null}
        <FieldError id={`${consentId}-error`} message={errors.consent} className="pl-6.5" />
      </div>
    </div>
  );
}

function FieldError({ id, message, className }: { id: string; message?: string; className?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className={`text-destructive text-[12px] ${className ?? ""}`}>
      {message}
    </p>
  );
}
