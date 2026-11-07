/**
 * The legal facts and clauses both documents state, so the Privacy Policy and
 * the Terms of Service can't drift apart (WP-4.6, D-114). Safe for the browser:
 * the operator's name is not here, it comes from lib/legal.ts.
 */

/** Shown as "Last updated" on both pages. Change it whenever the wording changes. */
export const LEGAL_LAST_UPDATED = "7 November 2026";

export const PRIVACY_EMAIL = "privacy@doqtri.xyz";
export const REFERRAL_LIMIT_EMAIL = "team@doqtri.xyz";

export const MINIMUM_AGE = 18;

/** The vault's existing-user notice. A new id shows it again to everyone. */
export const LEGAL_NOTICE_DISMISS_KEY = "legal-notice-dismissed:2026-11";

/** OPEN: the owner's draft position, waiting on the lawyer's answer (D-114). */
export const TAX_CLAUSE = "You are responsible for any tax due on referral rewards you receive.";

export const ONCHAIN_PERMANENCE_CLAUSE =
  "Anything anchored on the Stellar ledger is public and permanent. Deleting a note or an account does not remove it from the ledger.";

export const REFERRAL_DELETION_CLAUSE =
  "A reward already earned, and the referred wallet on it, stay after an account is deleted. So does the payout record (amount, date, method and reference), without account numbers. Payout details are deleted with the account. Unpaid rewards of a deleted referrer are voided.";

export const REFERRER_VIEW_CLAUSE =
  "A referrer sees each person they referred only as a partial email or wallet address with an activity count, and no display name.";

export const AGE_CLAUSE = `Doqtri is for people ${MINIMUM_AGE} or older. We do not verify age.`;
