import { createHmac } from "crypto";

/** Deterministic Supabase email for a Stellar public key. */
export function walletEmail(address: string): string {
  return `${address.toLowerCase()}@stellar.doqtri.local`;
}

/** Server-only password derived from the service role secret + address. */
export function walletPassword(address: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createHmac("sha256", secret).update(`doqtri-wallet:${address}`).digest("hex");
}

export function isStellarPublicKey(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
}
