import { isReservedEmail } from "@/lib/wallet-address";

/** Matches the minimum set in Supabase Auth (Dashboard -> Auth -> Providers -> Email). */
export const MIN_PASSWORD_LENGTH = 8;

/** Client-side checks; Supabase repeats its own on the server. */
export function signUpProblem(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Enter a valid email address.";
  if (isReservedEmail(email)) return "That email domain is reserved. Use your own email address.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
  }
  return null;
}

/**
 * Where an emailed link lands: /auth/confirm finishes the sign-in, then sends
 * the user to `next`. The origin must be in Supabase's redirect URL allowlist.
 */
export function confirmUrl(origin: string, next: string): string {
  return `${origin}/auth/confirm?next=${encodeURIComponent(next)}`;
}

/**
 * Only same-site paths: an emailed link's or auth screen's `next` must not
 * become an open redirect to another origin (`//evil.com`, `/\evil.com`,
 * `https://…`, or `/<tab>/evil.com`, which browsers read as `//evil.com`).
 * Resolving against a dummy origin catches every spelling the URL parser does.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/vault"): string {
  if (!next || !next.startsWith("/")) return fallback;
  try {
    const url = new URL(next, "http://same.site");
    if (url.origin !== "http://same.site") return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/** An auth screen's path, carrying `next` along unless it is the default. */
export function withNext(path: string, next: string): string {
  return next === "/vault" ? path : `${path}?next=${encodeURIComponent(next)}`;
}
