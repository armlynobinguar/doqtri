"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Loader2Icon, RotateCwIcon, SaveIcon, WalletIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { PRIVACY_PATH, TERMS_PATH } from "@/components/legal/legal-links";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  payoutDraft,
  readPayoutDetails,
  type PayoutDraft,
  type PayoutLoaded,
} from "@/components/vault/referral-payout-client";
import {
  createQuestionnaireSaver,
  readTestimonial,
  testimonialDraft,
  TESTIMONIAL_LOAD_FAILED,
  type QuestionnaireErrors,
  type TestimonialDraft,
  type TestimonialSlot,
} from "@/components/vault/referral-testimonial-client";
import { TestimonialFields } from "@/components/vault/referral-testimonial-fields";
import {
  PAYOUT_MEMO_ID_MAX,
  PAYOUT_MEMO_MAX_BYTES,
  PAYOUT_PROVIDERS,
  type PayoutField,
  type PayoutSummary,
} from "@/lib/referral-payout";
import type { TestimonialField } from "@/lib/referral-testimonial";
import { cn } from "@/lib/utils";

/**
 * The Privacy Policy (DOQ-27, on another branch until it merges). Never a dead
 * link to a user: the form exists only once LEGAL_OPERATOR_NAME is set, and that
 * switch is what publishes the legal pages.
 */
const PRIVACY_POLICY_HREF = "/privacy";

/** Top to bottom, for finding the first field with a problem. */
const FIELD_ORDER: (PayoutField | TestimonialField)[] = [
  "name",
  "method",
  "address",
  "memo",
  "memoType",
  "provider",
  "accountName",
  "accountNumber",
  "details",
  "feedback",
  "consent",
];

/**
 * The questionnaire (WP-4.6, DOQ-25, D-112). Opens on what GET returns, which is
 * the only time the full details reach the browser, and forgets them when closed:
 * nothing outside the dialog holds them.
 */
export function ReferralPayoutDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (summary: PayoutSummary) => void;
}) {
  const [saving, setSaving] = useState(false);

  return (
    <Dialog
      open={open}
      // A stray tap outside would lose a long form, and Escape and the buttons are there.
      disablePointerDismissal
      onOpenChange={(next) => {
        if (saving) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[520px]" data-testid="payout-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WalletIcon className="text-foreground size-4" strokeWidth={1.5} />
            Payout details
          </DialogTitle>
          <DialogDescription>
            Where we send your referral rewards. How we use these details is in the{" "}
            <Link href={PRIVACY_PATH} className="text-foreground underline underline-offset-2">
              Privacy Policy
            </Link>
            , and how payment works is in the{" "}
            <Link href={TERMS_PATH} className="text-foreground underline underline-offset-2">
              Terms of Service
            </Link>
            .
          </DialogDescription>
        </DialogHeader>
        <PayoutFormLoader
          saving={saving}
          onSavingChange={setSaving}
          onClose={() => onOpenChange(false)}
          onSaved={(summary) => {
            onSaved(summary);
            onOpenChange(false);
          }}
          onSummary={onSaved}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so each opening starts from the server's copy. */
function PayoutFormLoader({
  saving,
  onSavingChange,
  onClose,
  onSaved,
  onSummary,
}: {
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSaved: (summary: PayoutSummary) => void;
  onSummary: (summary: PayoutSummary) => void;
}) {
  const [loaded, setLoaded] = useState<PayoutLoaded | null>(null);
  const [testimonial, setTestimonial] = useState<TestimonialSlot>({ kind: "hidden" });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void (async () => {
      // The feedback on its own route (DOQ-28): it fails or is hidden without
      // keeping the details from loading.
      const [result, feedback] = await Promise.all([readPayoutDetails(), readTestimonial()]);
      if (!current) return;
      if ("message" in result) setError(result.message);
      else {
        setError(null);
        setTestimonial(feedback);
        setLoaded(result);
      }
    })();
    return () => {
      current = false;
    };
  }, [attempt]);

  if (loaded) {
    return (
      <PayoutForm
        initial={payoutDraft(loaded.profile)}
        canEdit={loaded.canEdit}
        testimonial={testimonial}
        saving={saving}
        onSavingChange={onSavingChange}
        onClose={onClose}
        onSaved={onSaved}
        onSummary={onSummary}
      />
    );
  }
  if (error) {
    return (
      <div className="grid justify-items-start gap-3" data-testid="payout-load-error">
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          <RotateCwIcon />
          Try again
        </Button>
      </div>
    );
  }
  return (
    <p className="text-muted-foreground flex items-center gap-2 text-[13px]" role="status" data-testid="payout-loading">
      <Loader2Icon className="size-4 animate-spin" /> Loading your details…
    </p>
  );
}

export function PayoutForm({
  initial,
  canEdit,
  testimonial = { kind: "hidden" },
  saving,
  onSavingChange,
  onClose,
  onSaved,
  onSummary,
}: {
  initial: PayoutDraft;
  /** False for an owner who no longer has an eligible referral: they can see what's stored, not change it. */
  canEdit: boolean;
  /** The feedback fields (DOQ-28): none unless the feedback route answered, which it does only once live. */
  testimonial?: TestimonialSlot;
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  /** Saved: the dialog closes. */
  onSaved: (summary: PayoutSummary) => void;
  /** The details were saved but the feedback wasn't: the dialog stays open, and the page learns the details. */
  onSummary?: (summary: PayoutSummary) => void;
}) {
  const baseId = useId();
  const [draft, setDraft] = useState(initial);
  const savedTestimonial = testimonial.kind === "ready" ? testimonial.testimonial : null;
  const [feedback, setFeedback] = useState<TestimonialDraft>(() => testimonialDraft(savedTestimonial));
  const [errors, setErrors] = useState<QuestionnaireErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Bumped to move focus to the first problem once it's on screen.
  const [problemCheck, setProblemCheck] = useState(0);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const [saver] = useState(() => createQuestionnaireSaver());
  // Someone without an eligible referral can still withdraw their consent.
  const canWithdraw = !canEdit && testimonial.kind === "ready" && Boolean(savedTestimonial?.consent);

  const fieldId = (field: PayoutField | TestimonialField) => `${baseId}-${field}`;
  const errorId = (field: PayoutField) => `${fieldId(field)}-error`;
  const hintId = (field: PayoutField) => `${fieldId(field)}-hint`;
  /** The hint, if the field has one, and the error, if there is one. */
  const describedBy = (field: PayoutField, hasHint = false) =>
    [hasHint ? hintId(field) : null, errors[field] ? errorId(field) : null].filter(Boolean).join(" ") || undefined;

  useEffect(() => {
    if (problemCheck === 0) return;
    const first = FIELD_ORDER.find((field) => errors[field]);
    if (first) document.getElementById(fieldId(first))?.focus();
    else formErrorRef.current?.focus();
    // Only when a submit found problems, not on every keystroke that clears one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemCheck]);

  function update(field: keyof PayoutDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  /** Either field's problem can be about the other (consent with no feedback), so a change to one clears both. */
  function updateFeedback(next: TestimonialDraft) {
    setErrors((current) =>
      current.feedback || current.consent ? { ...current, feedback: undefined, consent: undefined } : current,
    );
    setFeedback(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if ((!canEdit && !canWithdraw) || saver.saving) return;
    setFormError(null);
    const outcome = await saver.save(
      {
        draft,
        savedDraft: initial,
        canEditDetails: canEdit,
        testimonial: testimonial.kind === "ready" ? { saved: savedTestimonial, draft: feedback } : null,
      },
      () => onSavingChange(true),
    );
    if (outcome.kind === "busy") return;
    if (outcome.kind !== "invalid") onSavingChange(false);

    switch (outcome.kind) {
      case "saved":
        setErrors({});
        if (outcome.summary) {
          toast.success("Payout details saved");
          onSaved(outcome.summary);
        } else {
          if (outcome.testimonialSaved) toast.success("Feedback saved");
          onClose();
        }
        return;
      case "invalid":
        setErrors(outcome.errors);
        setProblemCheck((n) => n + 1);
        return;
      case "partial":
        onSummary?.(outcome.summary);
        setErrors(outcome.errors);
        setFormError(outcome.message);
        setProblemCheck((n) => n + 1);
        return;
      case "refused":
        if (outcome.testimonialSaved) toast.success("Feedback taken off the site");
        setErrors(outcome.errors);
        setFormError(outcome.message);
        setProblemCheck((n) => n + 1);
    }
  }

  /** What every text field shares. Read-only rather than disabled when it can't be changed, so it stays legible. */
  const textField = (
    field: Exclude<PayoutField, "method" | "provider" | "memoType">,
    required: boolean,
    hasHint = false,
  ) => ({
    id: fieldId(field),
    value: draft[field],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(field, event.target.value),
    disabled: saving,
    readOnly: !canEdit,
    required,
    autoComplete: "off",
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": describedBy(field, hasHint),
    "data-testid": `payout-${field}`,
  });

  // Characters, not bytes: a text memo has to be ASCII, where the two agree, and
  // a count in bytes would make anything else look longer than it reads.
  const memoLength = Array.from(draft.memo.trim()).length;
  const memoHint =
    draft.memoType === "id"
      ? `A whole number, up to ${PAYOUT_MEMO_ID_MAX}.`
      : `${memoLength}/${PAYOUT_MEMO_MAX_BYTES} characters: English letters, digits, spaces and common symbols.`;

  return (
    <form onSubmit={submit} noValidate className="grid min-w-0 gap-4 text-[13px]" data-testid="payout-form">
      {!canEdit ? (
        <p
          className="text-muted-foreground rounded-xl border border-[var(--glass-lo)] bg-[var(--glass)] px-3 py-2"
          data-testid="payout-read-only"
        >
          You don&apos;t have an eligible referral right now, so these details can&apos;t be changed.
        </p>
      ) : null}

      <PayoutFieldRow id={fieldId("name")} label="Name" required error={errors.name}>
        <Input {...textField("name", true)} autoComplete="name" />
      </PayoutFieldRow>

      <fieldset
        className="grid min-w-0 gap-1.5"
        aria-describedby={errors.method ? errorId("method") : undefined}
        data-testid="payout-method"
      >
        <legend className="text-muted-foreground mb-1 text-[12px]">
          Payout method
          <RequiredMark />
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["xlm", "XLM", "A Stellar account"],
              ["ewallet", "E-wallet or bank", "GCash, Maya, a bank, or other"],
            ] as const
          ).map(([value, label, hint], index) => (
            <label
              key={value}
              className={cn(
                "has-[:focus-visible]:ring-ring/50 flex min-w-0 cursor-pointer flex-col rounded-xl border p-3 transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-3",
                draft.method === value
                  ? "text-foreground border-[var(--glass-hi)] bg-[var(--glass-strong)]"
                  : "text-muted-foreground hover:text-foreground border-[var(--glass-lo)] bg-[var(--glass)] hover:border-[var(--glass-hi)]",
                errors.method && "border-destructive/60",
              )}
            >
              <input
                type="radio"
                name={`${baseId}-method`}
                // The first one is where a problem with the choice sends focus.
                id={index === 0 ? fieldId("method") : undefined}
                className="sr-only"
                value={value}
                checked={draft.method === value}
                required
                disabled={saving || !canEdit}
                onChange={() => update("method", value)}
                data-testid={`payout-method-${value}`}
              />
              <span className="text-[13px] font-medium">{label}</span>
              <span className="text-[12px] opacity-80">{hint}</span>
            </label>
          ))}
        </div>
        <FieldError id={errorId("method")} message={errors.method} />
      </fieldset>

      {draft.method === "xlm" ? (
        <div className="grid min-w-0 gap-3" data-testid="payout-xlm">
          <ul className="text-muted-foreground grid list-disc gap-1.5 pl-4 text-[12px]" data-testid="payout-xlm-notes">
            <li>
              Doqtri runs on testnet, but rewards are real XLM on mainnet. The address must be an activated mainnet
              account. We don&apos;t fill in your Doqtri wallet, because it&apos;s a testnet wallet.
            </li>
            <li>Exchanges usually require a memo, and XLM sent without one can be lost.</li>
            <li>Passkey wallet addresses, which start with C, can&apos;t receive payouts.</li>
          </ul>
          <PayoutFieldRow id={fieldId("address")} label="Stellar address" required error={errors.address}>
            <Input
              {...textField("address", true)}
              placeholder="G…"
              spellCheck={false}
              autoCapitalize="characters"
              autoCorrect="off"
              className="font-mono"
            />
          </PayoutFieldRow>
          <PayoutFieldRow id={fieldId("memo")} label="Memo" error={errors.memo} hint={memoHint}>
            <Input
              {...textField("memo", false, true)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              inputMode={draft.memoType === "id" ? "numeric" : "text"}
            />
          </PayoutFieldRow>
          <fieldset
            className="grid min-w-0 gap-1.5"
            aria-describedby={[hintId("memoType"), errors.memoType ? errorId("memoType") : null].filter(Boolean).join(" ")}
            data-testid="payout-memo-type"
          >
            <legend className="text-muted-foreground mb-1 text-[12px]">Memo type</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["text", "Text"],
                  ["id", "ID (a number)"],
                ] as const
              ).map(([value, label], index) => (
                <label
                  key={value}
                  className={cn(
                    "has-[:focus-visible]:ring-ring/50 flex min-h-9 cursor-pointer items-center rounded-[10px] border px-3 text-[13px] transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-3",
                    draft.memoType === value
                      ? "text-foreground border-[var(--glass-hi)] bg-[var(--glass-strong)]"
                      : "text-muted-foreground hover:text-foreground border-[var(--glass-lo)] bg-[var(--glass)] hover:border-[var(--glass-hi)]",
                  )}
                >
                  <input
                    type="radio"
                    name={`${baseId}-memo-type`}
                    id={index === 0 ? fieldId("memoType") : undefined}
                    className="sr-only"
                    value={value}
                    checked={draft.memoType === value}
                    disabled={saving || !canEdit}
                    onChange={() => update("memoType", value)}
                    data-testid={`payout-memo-type-${value}`}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p id={hintId("memoType")} className="text-label text-[12px]">
              If your address is at an exchange, use the memo and the type it shows. Sent as the wrong type, a memo
              may not reach your account.
            </p>
            <FieldError id={errorId("memoType")} message={errors.memoType} />
          </fieldset>
        </div>
      ) : null}

      {draft.method === "ewallet" ? (
        <div className="grid min-w-0 gap-3" data-testid="payout-ewallet">
          <PayoutFieldRow id={fieldId("provider")} label="Provider" required error={errors.provider}>
            <Select
              value={draft.provider || null}
              onValueChange={(next) => next && update("provider", next as string)}
              disabled={saving || !canEdit}
              required
            >
              <SelectTrigger
                id={fieldId("provider")}
                aria-invalid={errors.provider ? true : undefined}
                aria-describedby={describedBy("provider")}
                data-testid="payout-provider"
              >
                <SelectValue placeholder="Choose a provider" />
              </SelectTrigger>
              <SelectContent>
                {PAYOUT_PROVIDERS.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PayoutFieldRow>
          <PayoutFieldRow id={fieldId("accountName")} label="Account name" required error={errors.accountName}>
            <Input {...textField("accountName", true)} />
          </PayoutFieldRow>
          <PayoutFieldRow
            id={fieldId("accountNumber")}
            label="Account or bank number"
            required
            error={errors.accountNumber}
          >
            <Input {...textField("accountNumber", true)} spellCheck={false} />
          </PayoutFieldRow>
          <PayoutFieldRow
            id={fieldId("details")}
            label="Other details"
            error={errors.details}
            hint="Anything else we need, such as the bank's name or branch."
          >
            <Input {...textField("details", false, true)} />
          </PayoutFieldRow>
        </div>
      ) : null}

      {testimonial.kind === "ready" ? (
        <TestimonialFields
          idPrefix={baseId}
          saved={savedTestimonial}
          draft={feedback}
          canEdit={testimonial.canEdit}
          saving={saving}
          errors={errors}
          onChange={updateFeedback}
        />
      ) : testimonial.kind === "unavailable" ? (
        <p className="text-muted-foreground text-[12px]" data-testid="testimonial-unavailable">
          {TESTIMONIAL_LOAD_FAILED}
        </p>
      ) : null}

      <PayoutPrivacyNote sharing={testimonial.kind === "ready"} />

      {formError ? (
        <p
          ref={formErrorRef}
          tabIndex={-1}
          role="alert"
          className="text-destructive outline-none"
          data-testid="payout-form-error"
        >
          {formError}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onClose} data-testid="payout-cancel">
          <XIcon />
          {canEdit || canWithdraw ? "Cancel" : "Close"}
        </Button>
        {canEdit || canWithdraw ? (
          // Focusable while saving: a keyboard user's focus stays on the button they pressed.
          <Button
            type="submit"
            disabled={saving}
            focusableWhenDisabled
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            data-testid="payout-save"
          >
            {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            {saving ? "Saving…" : canEdit ? "Save details" : "Save"}
          </Button>
        ) : null}
      </DialogFooter>
    </form>
  );
}

/**
 * Who sees these details and why, and that an edit changes nothing already paid.
 * With the feedback fields shown (`sharing`), what may be public and when.
 */
function PayoutPrivacyNote({ sharing = false }: { sharing?: boolean }) {
  return (
    <div className="text-muted-foreground grid gap-1.5 text-[12px]" data-testid="payout-privacy">
      <p>
        Only you and Doqtri&apos;s admins can see these details. We use them only to pay your referral rewards.
        {sharing ? (
          <>
            {" "}
            Your name and feedback are shown publicly only if you tick the box above and an admin approves them.
          </>
        ) : null}
        {PRIVACY_POLICY_HREF ? (
          <>
            {" "}
            See the{" "}
            <Link href={PRIVACY_POLICY_HREF} className="hover:text-foreground underline underline-offset-2">
              Privacy Policy
            </Link>
            .
          </>
        ) : null}
      </p>
      <p>A change applies to future payouts only. Payouts already made aren&apos;t affected.</p>
    </div>
  );
}

function RequiredMark() {
  return (
    <span className="text-destructive">
      {" "}
      <span aria-hidden="true">*</span>
      <span className="sr-only">(required)</span>
    </span>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-destructive text-[12px]">
      {message}
    </p>
  );
}

function PayoutFieldRow({
  id,
  label,
  required = false,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-muted-foreground text-[12px]">
        {label}
        {required ? <RequiredMark /> : <span className="text-label"> (optional)</span>}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-label text-[12px]">
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
