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

/**
 * UNDECIDED. The owner left tax open: this is drafting wording only, not anyone's
 * position, and the pages can't go live until the lawyer has answered (D-114).
 */
export const TAX_CLAUSE = "You are responsible for any tax due on referral rewards you receive.";

export const ONCHAIN_PERMANENCE_CLAUSE =
  "Anything anchored on the Stellar ledger is public and permanent. Deleting a note or an account does not remove it from the ledger.";

export const REFERRAL_DELETION_CLAUSE =
  "If a person you referred deletes their account before qualifying, the referral is removed. If they delete it after qualifying, the reward stays, with their wallet address on it. If a referrer deletes their account, their unpaid rewards are voided and won't be paid, even if eligible. Those voided rewards and any paid ones stay on record, with the referred wallet address. Payout records stay too (amount, date, method and reference), without account numbers, though a reference can be a transaction hash, which shows the receiving wallet on the ledger. Payout details are deleted with the account.";

/** What a deleted account leaves behind that can still point to its owner. */
export const KEPT_CONTENT_CLAUSE =
  "What stays is not anonymous. Anchored notes stay tied to their owner's wallet on the ledger and in our list of on-chain writes. Templates and purchases keep their wallet. Records of lost signing rights keep your account id and wallet addresses, and import records keep your account id in the stored file's path. Your notes still say whatever you wrote in them.";

export const TESTIMONIAL_CLAUSE =
  "A testimonial shows your name and your feedback. It appears publicly only if you opt in and an admin approves it, and a reward never depends on it. Withdrawing your opt-in or deleting your account takes it down.";

export const REFERRER_VIEW_CLAUSE =
  "A referrer sees each person they referred only as a partial email or wallet address with an activity count, and no display name.";

export const AGE_CLAUSE = `Doqtri is for people ${MINIMUM_AGE} or older. We do not verify age.`;
