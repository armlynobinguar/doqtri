/**
 * What a referrer's payout details may be (WP-4.6, DOQ-25, D-112). The form and
 * PUT /api/referrals/payout-profile both run validatePayoutProfile(), and the
 * server's answer is the one that counts. Its messages are fixed text and never
 * quote what was typed, because these are financial details and errors get logged.
 *
 * Safe in the browser. The server's reads and writes are in
 * lib/referral-payout-profiles.ts.
 */
import { StrKey } from "@stellar/stellar-sdk";

export const PAYOUT_PROVIDERS = ["GCash", "Maya", "Bank", "Other"] as const;
export type PayoutProvider = (typeof PAYOUT_PROVIDERS)[number];

/**
 * In UTF-16 units, except the memo. The database checks the same numbers, in
 * backend/migrations/20261107120000_referral_payout_profiles.sql.
 */
export const PAYOUT_NAME_MAX = 100;
export const PAYOUT_ACCOUNT_NAME_MAX = 100;
export const PAYOUT_ACCOUNT_NUMBER_MAX = 40;
export const PAYOUT_DETAILS_MAX = 200;
/** Stellar's limit for a text memo, in bytes of UTF-8. */
export const PAYOUT_MEMO_MAX_BYTES = 28;
/** Bank and e-wallet formats vary too much for more than this: a mobile number has 10 or more, a bank account more. */
const PAYOUT_ACCOUNT_NUMBER_MIN_DIGITS = 6;

export type PayoutProfile =
  | { method: "xlm"; name: string; address: string; memo: string | null }
  | {
      method: "ewallet";
      name: string;
      provider: PayoutProvider;
      accountName: string;
      accountNumber: string;
      details: string | null;
    };

export type PayoutField = "name" | "method" | "address" | "memo" | "provider" | "accountName" | "accountNumber" | "details";

export type PayoutFieldErrors = Partial<Record<PayoutField, string>>;

export type PayoutValidation = { ok: true; profile: PayoutProfile } | { ok: false; errors: PayoutFieldErrors };

/** All a saved profile shows outside the form: which method, and the end of the number. */
export type PayoutSummary = { label: string; last4: string };

/** What the dashboard knows about a referrer's details. */
export type PayoutState = {
  /** At least one eligible referral: see hasEligibleReferral(). */
  canEdit: boolean;
  summary: PayoutSummary | null;
};

/**
 * Control characters, line breaks, lone surrogates (which can't be stored), and
 * the formatting characters that make text display in a different order from how
 * it reads, which could make a number look like another to whoever pays it.
 */
const FORBIDDEN = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}‪-‮⁦-⁩]/u;

const CHARACTERS = "Remove the line breaks or special characters.";

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Trimmed text, "" for nothing there, or null for something that isn't text at all. */
function readText(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim() : null;
}

/** The problem with a required or optional piece of plain text, if there is one. */
function textProblem(value: string | null, max: number, empty: string | null): string | null {
  if (value === null) return "Enter this as text.";
  if (!value) return empty;
  if (FORBIDDEN.test(value)) return CHARACTERS;
  if (value.length > max) return `Use ${max} characters or fewer.`;
  return null;
}

function addressProblem(address: string | null): string | null {
  if (address === null) return "Enter this as text.";
  if (!address) return "Enter your Stellar address.";
  if (/^C[A-Z2-7]{55}$/.test(address)) {
    return "This is a passkey wallet (C…) address, which can't receive payouts. Use a Stellar account address starting with G.";
  }
  if (!StrKey.isValidEd25519PublicKey(address)) {
    return "This isn't a valid Stellar address. It starts with G and has 56 characters.";
  }
  return null;
}

function memoProblem(memo: string | null): string | null {
  if (memo === null) return "Enter this as text.";
  if (FORBIDDEN.test(memo)) return CHARACTERS;
  if (utf8Bytes(memo) > PAYOUT_MEMO_MAX_BYTES) {
    return `A memo can be at most ${PAYOUT_MEMO_MAX_BYTES} bytes. Some characters count as more than one.`;
  }
  return null;
}

function accountNumberProblem(number: string | null): string | null {
  const problem = textProblem(number, PAYOUT_ACCOUNT_NUMBER_MAX, "Enter your account or bank number.");
  if (problem) return problem;
  const digits = number!.match(/\d/g)?.length ?? 0;
  return digits < PAYOUT_ACCOUNT_NUMBER_MIN_DIGITS ? "This doesn't look like an account number: it needs more digits." : null;
}

/**
 * The profile to store, with only the chosen method's fields: the other method's,
 * and anything else in `input`, such as a user_id, go no further than this.
 */
export function validatePayoutProfile(input: unknown): PayoutValidation {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const errors: PayoutFieldErrors = {};
  const note = (field: PayoutField, problem: string | null) => {
    if (problem) errors[field] = problem;
  };

  const name = readText(raw.name);
  note("name", textProblem(name, PAYOUT_NAME_MAX, "Enter your name."));

  if (raw.method === "xlm") {
    const address = readText(raw.address);
    const memo = readText(raw.memo);
    note("address", addressProblem(address));
    note("memo", memoProblem(memo));
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, profile: { method: "xlm", name: name!, address: address!, memo: memo || null } };
  }

  if (raw.method === "ewallet") {
    const provider = PAYOUT_PROVIDERS.find((known) => known === raw.provider);
    const accountName = readText(raw.accountName);
    const accountNumber = readText(raw.accountNumber);
    const details = readText(raw.details);
    if (!provider) errors.provider = "Choose a provider.";
    note("accountName", textProblem(accountName, PAYOUT_ACCOUNT_NAME_MAX, "Enter the name on the account."));
    note("accountNumber", accountNumberProblem(accountNumber));
    note("details", textProblem(details, PAYOUT_DETAILS_MAX, null));
    if (Object.keys(errors).length > 0 || !provider) return { ok: false, errors };
    return {
      ok: true,
      profile: {
        method: "ewallet",
        name: name!,
        provider,
        accountName: accountName!,
        accountNumber: accountNumber!,
        details: details || null,
      },
    };
  }

  errors.method = "Choose how you'd like to be paid.";
  return { ok: false, errors };
}

/** The last four characters at most, and never more than half, so a short number isn't shown whole. */
function lastCharacters(value: string): string {
  const letters = Array.from(value.replace(/[\s-]/g, ""));
  return letters.slice(-Math.min(4, Math.floor(letters.length / 2))).join("");
}

/** For the page's read view. The name, memo and the rest of the number stay out of it. */
export function payoutSummary(profile: PayoutProfile): PayoutSummary {
  return profile.method === "xlm"
    ? { label: "XLM", last4: lastCharacters(profile.address) }
    : { label: profile.provider, last4: lastCharacters(profile.accountNumber) };
}
