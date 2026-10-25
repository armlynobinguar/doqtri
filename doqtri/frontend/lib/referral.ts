import { createHmac, timingSafeEqual } from "crypto";

/**
 * Referral links: every user has one, `/r/<code>`, shared as the link itself,
 * as a QR code of the link (`/r/<code>?via=qr`), or as the bare code typed
 * into the sign-up form.
 *
 * Each stores the code, how it arrived and the time in a cookie, signed so
 * the time can't be backdated. After sign-up the vault calls
 * /api/referrals/claim once, and the database records the referral only if
 * the account was created after that time (see claim_referral in
 * backend/migrations/20261018000000_create_referrals.sql).
 */

export const REFERRAL_COOKIE = "doqtri_ref";

/** How long an opened link waits for the visitor to sign up. */
export const REFERRAL_TTL_MS = 30 * 24 * 60 * 60_000;

/** How a code reached the visitor; matches referrals.source. */
export const REFERRAL_SOURCES = ["link", "qr", "code"] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

export function isReferralSource(value: unknown): value is ReferralSource {
  return REFERRAL_SOURCES.includes(value as ReferralSource);
}

/** The same alphabet as the database: no 0, 1, i, l or o. */
const CODE_PATTERN = /^[a-hjkmnp-z2-9]{8}$/;

/** Lowercases and trims `raw`; null unless it is a well-formed code. */
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  const code = raw?.trim().toLowerCase() ?? "";
  return CODE_PATTERN.test(code) ? code : null;
}

/** The link a user shares, e.g. https://doqtri.app/r/k7m2pq9x, tagged when it is printed as a QR code. */
export function referralUrl(origin: string, code: string, via?: "qr"): string {
  return `${origin.replace(/\/+$/, "")}/r/${code}${via ? `?via=${via}` : ""}`;
}

/** Options for the referral cookie, the same wherever it is set. */
export function referralCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: REFERRAL_TTL_MS / 1000 } as const;
}

// Its own key, so a referral signature can never pass as anything else.
function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("doqtri-referral-cookie").digest();
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", key(secret)).update(body).digest("base64url");
}

/** Cookie value for `code` seen at `openedAt` (ms) via `source`: `<code>.<openedAt>.<source>.<signature>`. */
export function createReferralCookie(code: string, openedAt: number, source: ReferralSource, secret: string): string {
  const body = `${code}.${openedAt}.${source}`;
  return `${body}.${sign(body, secret)}`;
}

export type ReferralCookie = { code: string; openedAt: number; source: ReferralSource };

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
  // Cookies set before sources were recorded have no source part: a link.
  if (parts.length !== 3 && parts.length !== 4) return null;
  const signature = parts.pop()!;
  const [rawCode, rawOpenedAt, rawSource] = parts;
  const source = rawSource ?? "link";

  const code = normalizeReferralCode(rawCode);
  const openedAt = Number(rawOpenedAt);
  if (
    !code ||
    code !== rawCode ||
    !/^\d{1,15}$/.test(rawOpenedAt) ||
    !Number.isSafeInteger(openedAt) ||
    !isReferralSource(source)
  ) {
    return null;
  }

  const expected = Buffer.from(sign(parts.join("."), secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  // A minute of slack for clock differences between servers.
  if (openedAt > now + 60_000 || now - openedAt > REFERRAL_TTL_MS) return null;
  return { code, openedAt, source };
}
