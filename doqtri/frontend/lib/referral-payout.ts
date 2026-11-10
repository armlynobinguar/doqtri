/**
 * What a referrer's payout details may be (WP-4.6, DOQ-25, D-112). The form and
 * PUT /api/referrals/payout-profile both run validatePayoutProfile(), and the
 * server's answer is the one that counts. Its messages are fixed text and never
 * quote what was typed, because these are financial details.
 *
 * Whoever pays copies these by hand, so what they see has to be all there is:
 * nothing invisible inside, and no look-alike digits. The database refuses the
 * same characters (backend/migrations/20261107120000_referral_payout_profiles.sql).
 *
 * Safe in the browser. The server's reads and writes are in
 * lib/referral-payout-profiles.ts.
 */
import { StrKey } from "@stellar/stellar-sdk";

export const PAYOUT_PROVIDERS = ["GCash", "Maya", "Bank", "Other"] as const;
export type PayoutProvider = (typeof PAYOUT_PROVIDERS)[number];

/** A text memo is what an exchange shows as letters and digits; an ID memo is a number. */
export const PAYOUT_MEMO_TYPES = ["text", "id"] as const;
export type PayoutMemoType = (typeof PAYOUT_MEMO_TYPES)[number];

/**
 * In characters (code points), as Postgres's char_length counts them, except the
 * memo. The database checks the same numbers.
 */
export const PAYOUT_NAME_MAX = 100;
export const PAYOUT_ACCOUNT_NAME_MAX = 100;
export const PAYOUT_ACCOUNT_NUMBER_MAX = 40;
export const PAYOUT_DETAILS_MAX = 200;
/** Stellar's limit for a text memo, in bytes. A text memo here is ASCII, so bytes and characters agree. */
export const PAYOUT_MEMO_MAX_BYTES = 28;
/** Stellar's ID memo is an unsigned 64-bit integer. */
export const PAYOUT_MEMO_ID_MAX = BigInt("18446744073709551615");
/**
 * Bank and e-wallet formats vary too much to check more than this: some digits,
 * and a plausible length. A mobile number has 10 or more, a bank account more.
 */
export const PAYOUT_ACCOUNT_NUMBER_MIN_DIGITS = 6;

export type PayoutMethod = "xlm" | "ewallet";

export type PayoutProfile =
  | { method: "xlm"; name: string; address: string; memo: string | null; memoType: PayoutMemoType | null }
  | {
      method: "ewallet";
      name: string;
      provider: PayoutProvider;
      accountName: string;
      accountNumber: string;
      details: string | null;
    };

export type PayoutField =
  | "name"
  | "method"
  | "address"
  | "memo"
  | "memoType"
  | "provider"
  | "accountName"
  | "accountNumber"
  | "details";

export type PayoutFieldErrors = Partial<Record<PayoutField, string>>;

export type PayoutValidation = { ok: true; profile: PayoutProfile } | { ok: false; errors: PayoutFieldErrors };

/**
 * All a saved profile shows outside the form: which method, the end of the
 * address or number, and for XLM which kind of memo there is, never the memo.
 */
export type PayoutSummary = { label: string; last4: string; memoType?: PayoutMemoType | null };

/** What the dashboard knows about a referrer's details. */
export type PayoutState = {
  /** At least one eligible referral: see hasEligibleReferral(). */
  canEdit: boolean;
  summary: PayoutSummary | null;
  /** The saved details couldn't be read just now: whether there are any is unknown. */
  unavailable?: boolean;
};

/**
 * What no field may hold: control characters (line breaks and tabs among them),
 * every format character (zero-width spaces and joiners, soft hyphens, the marks
 * that reorder text, byte order marks, tags), line and paragraph separators,
 * lone surrogates, and the blank characters that draw nothing: Hangul fillers
 * and the empty Braille pattern. Each could make what's shown differ from what's
 * stored, or a required field look filled in.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u115f\u1160\u2800\u3164\uffa0]/u;
/** A name has to say something: at least one letter or number, in any script. */
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
/** ASCII only, so a fullwidth or Arabic-Indic digit, or anything invisible, can't hide in it. */
const ACCOUNT_NUMBER = /^[0-9A-Za-z -]+$/;
/** Printable ASCII, U+0020 to U+007E: what every wallet and exchange can type and show alike. */
const TEXT_MEMO = /^[\x20-\x7E]+$/;
/** A whole number in decimal, written the one way: no sign, spaces or leading zeros. */
const ID_MEMO = /^(0|[1-9][0-9]*)$/;

const CHARACTERS = "Remove the line breaks or special characters.";
const NOT_TEXT = "Enter this as text.";

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Characters as a person and Postgres count them: an emoji is one, not two. */
function characters(text: string): number {
  return Array.from(text).length;
}

/** Trimmed text, "" for nothing there, or null for something that isn't text at all. */
export function readText(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim() : null;
}

/**
 * The problem with a required (`empty` says what to do) or optional (`empty` null)
 * piece of text. The testimonial's feedback (lib/referral-testimonial.ts) uses it too.
 */
export function textProblem(value: string | null, max: number, empty: string | null): string | null {
  if (value === null) return NOT_TEXT;
  if (!value) return empty;
  if (INVISIBLE.test(value)) return CHARACTERS;
  if (!LETTER_OR_NUMBER.test(value)) return "Use at least one letter or number.";
  if (characters(value) > max) return `Use ${max} characters or fewer.`;
  return null;
}

export const PASSKEY_ADDRESS =
  "This is a passkey wallet (C…) address, which can't receive payouts. Use a Stellar account address starting with G.";
const MUXED_ADDRESS =
  "This is a muxed (M…) address. Use the G address your exchange shows, and put its memo in the memo field.";
const INVALID_ADDRESS = "This isn't a valid Stellar address. It starts with G and has 56 characters.";

function addressProblem(address: string | null): string | null {
  if (address === null) return NOT_TEXT;
  if (!address) return "Enter your Stellar address.";
  // Before the checksum: a passkey address with a typo is still a passkey address.
  if (/^C[A-Z2-7]{55}$/.test(address)) return PASSKEY_ADDRESS;
  if (/^M[A-Z2-7]{68}$/.test(address)) return MUXED_ADDRESS;
  return StrKey.isValidEd25519PublicKey(address) ? null : INVALID_ADDRESS;
}

function memoProblem(memo: string, type: PayoutMemoType): string | null {
  if (type === "id") {
    if (!ID_MEMO.test(memo)) return "An ID memo is a whole number, with no spaces, sign or leading zeros.";
    return BigInt(memo) > PAYOUT_MEMO_ID_MAX ? "An ID memo can be at most 18446744073709551615." : null;
  }
  if (!TEXT_MEMO.test(memo)) {
    return "A text memo can use only English letters, digits, spaces and common symbols.";
  }
  if (utf8Bytes(memo) > PAYOUT_MEMO_MAX_BYTES) return `A text memo can be at most ${PAYOUT_MEMO_MAX_BYTES} characters.`;
  return null;
}

function accountNumberProblem(number: string | null): string | null {
  if (number === null) return NOT_TEXT;
  if (!number) return "Enter your account or bank number.";
  if (!ACCOUNT_NUMBER.test(number)) return "Use only digits, English letters, spaces and dashes.";
  if (number.length > PAYOUT_ACCOUNT_NUMBER_MAX) return `Use ${PAYOUT_ACCOUNT_NUMBER_MAX} characters or fewer.`;
  const digits = number.match(/[0-9]/g)?.length ?? 0;
  return digits < PAYOUT_ACCOUNT_NUMBER_MIN_DIGITS
    ? "This doesn't look like an account number: it needs more digits."
    : null;
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
    let memoType: PayoutMemoType | null = null;
    if (memo === null) note("memo", NOT_TEXT);
    else if (memo) {
      memoType = PAYOUT_MEMO_TYPES.find((known) => known === raw.memoType) ?? null;
      if (!memoType) note("memoType", "Choose whether the memo is text or an ID.");
      else note("memo", memoProblem(memo, memoType));
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return {
      ok: true,
      profile: { method: "xlm", name: name!, address: address!, memo: memo || null, memoType: memo ? memoType : null },
    };
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
export function lastCharacters(value: string): string {
  const letters = Array.from(value.replace(/[\s-]/g, ""));
  const shown = Math.min(4, Math.floor(letters.length / 2));
  // slice(-0) would be the whole of it.
  return shown > 0 ? letters.slice(-shown).join("") : "";
}

/** For the page's read view. The name, the memo itself and the rest of the number stay out of it. */
export function payoutSummary(
  profile:
    | Pick<Extract<PayoutProfile, { method: "xlm" }>, "method" | "address" | "memoType">
    | Pick<Extract<PayoutProfile, { method: "ewallet" }>, "method" | "provider" | "accountNumber">,
): PayoutSummary {
  return profile.method === "xlm"
    ? { label: "XLM", last4: lastCharacters(profile.address), memoType: profile.memoType }
    : { label: profile.provider, last4: lastCharacters(profile.accountNumber) };
}
