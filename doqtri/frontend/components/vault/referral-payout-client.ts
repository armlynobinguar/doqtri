import {
  validatePayoutProfile,
  type PayoutFieldErrors,
  type PayoutProfile,
  type PayoutState,
  type PayoutSummary,
} from "@/lib/referral-payout";

/*
 * The payout questionnaire's logic (WP-4.6, DOQ-25, D-112), apart from React so
 * that it can be tested without a DOM, which the unit tests don't have:
 * components/vault/referral-payout-dialog.tsx draws it.
 */

export const PAYOUT_ROUTE = "/api/referrals/payout-profile";
export const LOAD_FAILED = "Your payout details couldn't be loaded.";
export const SAVE_FAILED = "Your payout details couldn't be saved.";

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

/**
 * The fields as they open: what's saved, or nothing. Never anything else the app
 * knows, such as the user's own testnet wallet, which can't receive mainnet XLM.
 */
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

export type PayoutLoaded = { profile: PayoutProfile | null; canEdit: boolean };

/** The saved details, in full, for the form: the only time they reach the browser. Never from a cache. */
export async function readPayoutDetails(): Promise<PayoutLoaded | { message: string }> {
  try {
    const res = await fetch(PAYOUT_ROUTE, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (PayoutLoaded & { error?: string }) | null;
    if (!res.ok || !body || typeof body.canEdit !== "boolean") return { message: body?.error || LOAD_FAILED };
    return { profile: body.profile ?? null, canEdit: body.canEdit };
  } catch {
    return { message: LOAD_FAILED };
  }
}

export type PayoutWritten = { summary: PayoutSummary } | { message: string; fields: PayoutFieldErrors };

/** Sends what passed the form's check. The server checks it again, and its answer wins. */
export async function writePayoutDetails(profile: PayoutProfile): Promise<PayoutWritten> {
  try {
    const res = await fetch(PAYOUT_ROUTE, {
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

export type PayoutSaveOutcome =
  /** Another save is still going: this press did nothing. */
  | { kind: "busy" }
  /** The form's own check found problems; nothing was sent. */
  | { kind: "invalid"; errors: PayoutFieldErrors }
  | { kind: "saved"; summary: PayoutSummary }
  | { kind: "refused"; message: string; errors: PayoutFieldErrors };

/**
 * One save at a time, whatever the button's state says: React's arrives a render
 * late, and a double press or Enter held down doesn't wait for it.
 */
export function createPayoutSaver(write: (profile: PayoutProfile) => Promise<PayoutWritten> = writePayoutDetails) {
  let saving = false;
  return {
    get saving() {
      return saving;
    },
    /** `onSend` runs once the form's check has passed, as the request goes. */
    async save(draft: PayoutDraft, onSend?: () => void): Promise<PayoutSaveOutcome> {
      if (saving) return { kind: "busy" };
      const checked = validatePayoutProfile(draft);
      if (!checked.ok) return { kind: "invalid", errors: checked.errors };
      saving = true;
      onSend?.();
      try {
        const written = await write(checked.profile);
        return "summary" in written
          ? { kind: "saved", summary: written.summary }
          : { kind: "refused", message: written.message, errors: written.fields };
      } finally {
        saving = false;
      }
    },
  };
}

export type PayoutCard =
  /** An unpaid reward and nothing saved: the prompt, which opens the form. */
  | { kind: "needed" }
  /** Saved: the masked summary, with Edit (or View, for someone who can no longer change it). */
  | { kind: "saved"; summary: PayoutSummary; canEdit: boolean }
  /** Eligible but nothing owed right now, and nothing saved: an offer to add them. */
  | { kind: "empty" };

/**
 * What the dashboard's payout card says, or null for none: someone with neither
 * details nor an eligible referral. What a save just returned wins over the
 * page's data, which was read before it.
 */
export function payoutCard(
  payout: PayoutState,
  payoutNeeded: boolean,
  justSaved: PayoutSummary | null,
): PayoutCard | null {
  const summary = justSaved ?? payout.summary;
  if (summary) return { kind: "saved", summary, canEdit: payout.canEdit };
  if (payoutNeeded) return { kind: "needed" };
  return payout.canEdit ? { kind: "empty" } : null;
}
