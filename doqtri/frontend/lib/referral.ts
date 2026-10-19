import { createHmac, timingSafeEqual } from "crypto";

/**
 * Referral links: every user has one, `/r/<code>`.
 *
 * Opening a link stores the code and the time it was opened in a cookie,
 * signed so the time can't be backdated. After sign-up the vault calls
 * /api/referrals/claim once, and the database records the referral only if
 * the account was created after that time (see claim_referral in
 * backend/migrations/20261018000000_create_referrals.sql).
 */

export const REFERRAL_COOKIE = "doqtri_ref";

/** How long an opened link waits for the visitor to sign up. */
export const REFERRAL_TTL_MS = 30 * 24 * 60 * 60_000;

/** The same alphabet as the database: no 0, 1, i, l or o. */
const CODE_PATTERN = /^[a-hjkmnp-z2-9]{8}$/;

/** Lowercases and trims `raw`; null unless it is a well-formed code. */
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  const code = raw?.trim().toLowerCase() ?? "";
  return CODE_PATTERN.test(code) ? code : null;
}

/** The link a user shares, e.g. https://doqtri.app/r/k7m2pq9x. */
export function referralUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/r/${code}`;
}

// Its own key, so a referral signature can never pass as anything else.
function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("doqtri-referral-cookie").digest();
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", key(secret)).update(body).digest("base64url");
}

/** Cookie value for `code` opened at `openedAt` (ms): `<code>.<openedAt>.<signature>`. */
export function createReferralCookie(code: string, openedAt: number, secret: string): string {
  const body = `${code}.${openedAt}`;
  return `${body}.${sign(body, secret)}`;
}

export type ReferralCookie = { code: string; openedAt: number };

/**
 * The code and open time in a cookie this app signed, or null when the value
 * is missing, malformed, tampered with, from the future, or expired.
 */
export function readReferralCookie(
  value: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): ReferralCookie | null {
  const parts = value?.split(".") ?? [];
  if (parts.length !== 3) return null;
  const [rawCode, rawOpenedAt, signature] = parts;

  const code = normalizeReferralCode(rawCode);
  const openedAt = Number(rawOpenedAt);
  if (!code || code !== rawCode || !/^\d{1,15}$/.test(rawOpenedAt) || !Number.isSafeInteger(openedAt)) {
    return null;
  }

  const expected = Buffer.from(sign(`${rawCode}.${rawOpenedAt}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  // A minute of slack for clock differences between servers.
  if (openedAt > now + 60_000 || now - openedAt > REFERRAL_TTL_MS) return null;
  return { code, openedAt };
}
