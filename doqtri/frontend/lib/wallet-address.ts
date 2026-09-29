/** Client-safe: a Stellar account public key (G...), as the session is keyed by. */
export function isStellarPublicKey(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
}
