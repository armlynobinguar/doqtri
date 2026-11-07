"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2Icon, RotateCwIcon, SaveIcon, WalletIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
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
  PAYOUT_MEMO_MAX_BYTES,
  PAYOUT_PROVIDERS,
  utf8Bytes,
  validatePayoutProfile,
  type PayoutField,
  type PayoutFieldErrors,
  type PayoutProfile,
  type PayoutSummary,
} from "@/lib/referral-payout";
import { cn } from "@/lib/utils";

const ROUTE = "/api/referrals/payout-profile";
const LOAD_FAILED = "Your payout details couldn't be loaded.";
const SAVE_FAILED = "Your payout details couldn't be saved.";

/** What's in the fields. Each method's stay here while the other is chosen, and only the chosen one's is sent. */
export type PayoutDraft = {
  name: string;
  method: "" | "xlm" | "ewallet";
  address: string;
  memo: string;
  provider: string;
  accountName: string;
  accountNumber: string;
  details: string;
};

/** Top to bottom, for finding the first field with a problem. */
const FIELD_ORDER: PayoutField[] = ["name", "method", "address", "memo", "provider", "accountName", "accountNumber", "details"];

export function payoutDraft(profile: PayoutProfile | null): PayoutDraft {
  const empty: PayoutDraft = {
    name: "",
    method: "",
    address: "",
    memo: "",
    provider: "",
    accountName: "",
    accountNumber: "",
    details: "",
  };
  if (!profile) return empty;
  return profile.method === "xlm"
    ? { ...empty, name: profile.name, method: "xlm", address: profile.address, memo: profile.memo ?? "" }
    : {
        ...empty,
        name: profile.name,
        method: "ewallet",
        provider: profile.provider,
        accountName: profile.accountName,
        accountNumber: profile.accountNumber,
        details: profile.details ?? "",
      };
}

type Loaded = { profile: PayoutProfile | null; canEdit: boolean };

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
          <DialogDescription>Where we send your referral rewards.</DialogDescription>
        </DialogHeader>
        <PayoutFormLoader
          saving={saving}
          onSavingChange={setSaving}
          onClose={() => onOpenChange(false)}
          onSaved={(summary) => {
            onSaved(summary);
            onOpenChange(false);
          }}
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
}: {
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSaved: (summary: PayoutSummary) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void (async () => {
      const result = await readPayoutDetails();
      if (!current) return;
      if ("message" in result) setError(result.message);
      else {
        setError(null);
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
        saving={saving}
        onSavingChange={onSavingChange}
        onClose={onClose}
        onSaved={onSaved}
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

async function readPayoutDetails(): Promise<Loaded | { message: string }> {
  try {
    const res = await fetch(ROUTE, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (Loaded & { error?: string }) | null;
    if (!res.ok || !body || typeof body.canEdit !== "boolean") return { message: body?.error || LOAD_FAILED };
    return { profile: body.profile, canEdit: body.canEdit };
  } catch {
    return { message: LOAD_FAILED };
  }
}

/** Sends what passed the form's check. The server checks it again, and its answer wins. */
async function writePayoutDetails(
  profile: PayoutProfile,
): Promise<{ summary: PayoutSummary } | { message: string; fields: PayoutFieldErrors }> {
  try {
    const res = await fetch(ROUTE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    const body = (await res.json().catch(() => null)) as {
      summary?: PayoutSummary;
      error?: string;
      fields?: PayoutFieldErrors;
    } | null;
    if (res.ok && body?.summary) return { summary: body.summary };
    return { message: body?.error || SAVE_FAILED, fields: body?.fields ?? {} };
  } catch {
    return { message: SAVE_FAILED, fields: {} };
  }
}

export function PayoutForm({
  initial,
  canEdit,
  saving,
  onSavingChange,
  onClose,
  onSaved,
}: {
  initial: PayoutDraft;
  /** False for an owner who no longer has an eligible referral: they can see what's stored, not change it. */
  canEdit: boolean;
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSaved: (summary: PayoutSummary) => void;
}) {
  const baseId = useId();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<PayoutFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Bumped to move focus to the first problem once it's on screen.
  const [problemCheck, setProblemCheck] = useState(0);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  // State arrives a render late, and a double press doesn't wait for it.
  const inFlight = useRef(false);

  const fieldId = (field: PayoutField) => `${baseId}-${field}`;

  useEffect(() => {
    if (problemCheck === 0) return;
    const first = FIELD_ORDER.find((field) => errors[field]);
    if (first) document.getElementById(fieldId(first))?.focus();
    else formErrorRef.current?.focus();
    // Only when a submit found problems, not on every keystroke that clears one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemCheck]);

  function update(field: PayoutField, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canEdit || inFlight.current) return;
    setFormError(null);

    const result = validatePayoutProfile(draft);
    if (!result.ok) {
      setErrors(result.errors);
      setProblemCheck((n) => n + 1);
      return;
    }

    inFlight.current = true;
    onSavingChange(true);
    setErrors({});
    const written = await writePayoutDetails(result.profile);
    inFlight.current = false;
    onSavingChange(false);

    if ("summary" in written) {
      toast.success("Payout details saved");
      onSaved(written.summary);
      return;
    }
    setErrors(written.fields);
    setFormError(written.message);
    setProblemCheck((n) => n + 1);
  }

  /** What every text field shares. Read-only rather than disabled when it can't be changed, so it stays legible. */
  const textField = (field: PayoutField, required: boolean) => ({
    id: fieldId(field),
    value: draft[field],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(field, event.target.value),
    disabled: saving,
    readOnly: !canEdit,
    required,
    autoComplete: "off",
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? `${fieldId(field)}-error` : undefined,
    "data-testid": `payout-${field}`,
  });

  const memoBytes = utf8Bytes(draft.memo.trim());

  return (
    <form onSubmit={submit} noValidate className="grid min-w-0 gap-4 text-[13px]" data-testid="payout-form">
      {!canEdit ? (
        <p className="text-muted-foreground rounded-xl border border-[var(--glass-lo)] bg-[var(--glass)] px-3 py-2" data-testid="payout-read-only">
          You don&apos;t have an eligible referral right now, so these details can&apos;t be changed.
        </p>
      ) : null}

      <PayoutFieldRow id={fieldId("name")} label="Name" required error={errors.name}>
        <Input {...textField("name", true)} autoComplete="name" />
      </PayoutFieldRow>

      <fieldset
        className="grid min-w-0 gap-1.5"
        aria-describedby={errors.method ? `${fieldId("method")}-error` : undefined}
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
        <FieldError id={`${fieldId("method")}-error`} message={errors.method} />
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
            <Input {...textField("address", true)} placeholder="G…" spellCheck={false} autoCapitalize="characters" autoCorrect="off" />
          </PayoutFieldRow>
          <PayoutFieldRow
            id={fieldId("memo")}
            label="Memo"
            error={errors.memo}
            hint={`${memoBytes}/${PAYOUT_MEMO_MAX_BYTES} bytes. If your address is at an exchange, use the memo it gave you.`}
          >
            <Input {...textField("memo", false)} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          </PayoutFieldRow>
        </div>
      ) : null}

      {draft.method === "ewallet" ? (
        <div className="grid min-w-0 gap-3" data-testid="payout-ewallet">
          <PayoutFieldRow id={fieldId("provider")} label="Provider" required error={errors.provider}>
            <Select
              value={draft.provider || null}
              onValueChange={(next) => next && update("provider", next as string)}
              disabled={saving || !canEdit}
            >
              <SelectTrigger
                id={fieldId("provider")}
                aria-invalid={errors.provider ? true : undefined}
                aria-describedby={errors.provider ? `${fieldId("provider")}-error` : undefined}
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
          <PayoutFieldRow id={fieldId("accountNumber")} label="Account or bank number" required error={errors.accountNumber}>
            <Input {...textField("accountNumber", true)} spellCheck={false} />
          </PayoutFieldRow>
          <PayoutFieldRow
            id={fieldId("details")}
            label="Other details"
            error={errors.details}
            hint="Anything else we need, such as the bank's name or branch."
          >
            <Input {...textField("details", false)} />
          </PayoutFieldRow>
        </div>
      ) : null}

      <PayoutPrivacyNote />

      {formError ? (
        <p ref={formErrorRef} tabIndex={-1} role="alert" className="text-destructive outline-none" data-testid="payout-form-error">
          {formError}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onClose} data-testid="payout-cancel">
          <XIcon />
          {canEdit ? "Cancel" : "Close"}
        </Button>
        {canEdit ? (
          // Focusable while saving: a keyboard user's focus stays on the button they pressed.
          <Button
            type="submit"
            disabled={saving}
            focusableWhenDisabled
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            data-testid="payout-save"
          >
            {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            {saving ? "Saving…" : "Save details"}
          </Button>
        ) : null}
      </DialogFooter>
    </form>
  );
}

/**
 * Who sees this, and that an edit changes nothing already paid.
 *
 * THE PRIVACY POLICY LINK GOES HERE (DOQ-25 needs it, the page is DOQ-27 on another
 * branch): link "Privacy Policy" in the first sentence once /privacy is on this one.
 */
function PayoutPrivacyNote() {
  return (
    <div className="text-muted-foreground grid gap-1.5 text-[12px]" data-testid="payout-privacy">
      <p>Only you and Doqtri&apos;s admins can see these details. We use them only to pay your referral rewards.</p>
      <p>A change applies to future payouts only. Payouts already made aren&apos;t affected.</p>
    </div>
  );
}

function RequiredMark() {
  return (
    <span className="text-destructive" title="Required">
      {" "}
      *<span className="sr-only"> required</span>
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
      {hint ? <p className="text-label text-[12px]">{hint}</p> : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
