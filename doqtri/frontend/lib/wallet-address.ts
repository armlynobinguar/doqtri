/** Client-safe: a Stellar account public key (G...), as the session is keyed by. */
export function isStellarPublicKey(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
}

/**
 * Wallet users are Supabase users with a synthetic email on this domain
 * (lib/wallet-auth.ts). Nobody can receive mail there, so it is reserved: an
 * email sign-up must never claim it.
 */
export const WALLET_EMAIL_DOMAIN = "stellar.doqtri.local";

export function isReservedEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${WALLET_EMAIL_DOMAIN}`);
}

/**
 * The wallet a session belongs to, read from the session's own email — which
 * only the wallet route can set — rather than from `user_metadata`, which the
 * user can rewrite through `auth.updateUser`. Null for email accounts.
 */
export function walletAddressFromEmail(email: string | null | undefined): string | null {
  if (!email || !isReservedEmail(email)) return null;
  const address = email.slice(0, email.indexOf("@")).toUpperCase();
  return isStellarPublicKey(address) ? address : null;
}
