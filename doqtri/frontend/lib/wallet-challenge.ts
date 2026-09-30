import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { isStellarPublicKey } from "@/lib/wallet-address";

/**
 * Proof of wallet ownership for sign-in (server-only).
 *
 * The server issues a short-lived challenge bound to one address; the wallet
 * signs its message with SEP-53 (`signMessage`), and the session exchange only
 * proceeds if that signature verifies against the address. Knowing a public
 * key — which is public by definition — is no longer enough to sign in.
 *
 * Challenges are stateless: the token is an HMAC over the payload, so there is
 * no table to write. They expire after CHALLENGE_TTL_MS.
 */

export const CHALLENGE_TTL_MS = 5 * 60_000;

type Payload = { a: string; n: string; e: number };

export type WalletChallenge = { message: string; token: string; expiresAt: number };

function key(secret: string): Buffer {
  // Separate key from the one that derives wallet passwords (lib/wallet-auth.ts).
  return createHmac("sha256", secret).update("doqtri-wallet-challenge").digest();
}

function mac(secret: string, body: string): string {
  return createHmac("sha256", key(secret)).update(body).digest("base64url");
}

/** The exact text the wallet signs. Human-readable so the user knows what they approve. */
export function challengeMessage(address: string, nonce: string, expiresAt: number): string {
  return [
    "Sign in to Doqtri",
    "",
    `Account: ${address}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    "",
    "Signing proves you own this wallet. It costs nothing and sends no transaction.",
  ].join("\n");
}

export function createWalletChallenge(
  address: string,
  secret: string,
  now = Date.now(),
): WalletChallenge {
  if (!isStellarPublicKey(address)) throw new Error("Invalid Stellar address");
  const payload: Payload = { a: address, n: randomBytes(16).toString("hex"), e: now + CHALLENGE_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    message: challengeMessage(payload.a, payload.n, payload.e),
    token: `${body}.${mac(secret, body)}`,
    expiresAt: payload.e,
  };
}

export type ChallengeResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "tampered" | "expired" | "wrong-address" | "bad-signature" };

export function verifyWalletChallenge(
  params: { address: string; token: string; signature: string },
  secret: string,
  now = Date.now(),
): ChallengeResult {
  const { address, token, signature } = params;
  const [body, tag] = token.split(".");
  if (!body || !tag) return { ok: false, reason: "malformed" };

  const expected = Buffer.from(mac(secret, body));
  const given = Buffer.from(tag);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "tampered" };
  }

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.a !== address) return { ok: false, reason: "wrong-address" };
  if (!(now < payload.e)) return { ok: false, reason: "expired" };

  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return { ok: false, reason: "bad-signature" };
  try {
    const message = challengeMessage(payload.a, payload.n, payload.e);
    if (!Keypair.fromPublicKey(address).verifyMessage(message, sig)) {
      return { ok: false, reason: "bad-signature" };
    }
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true };
}
