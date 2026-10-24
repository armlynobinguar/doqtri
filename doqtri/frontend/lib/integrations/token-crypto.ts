import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

/**
 * Encryption for integration secrets at rest (WP-2.3; server-only).
 *
 * OAuth tokens are encrypted here, before they reach the database, with
 * AES-256-GCM under INTEGRATION_TOKEN_KEY: 32 random bytes, base64 or hex
 * (`openssl rand -base64 32`). The database only ever holds ciphertext, so a
 * leaked backup or a mistaken policy exposes nothing usable.
 *
 * Every ciphertext is bound to what it is for through GCM's additional data
 * (e.g. "qdit:access:<user id>"): a value copied into another user's row, or
 * from the refresh column into the access column, fails to decrypt rather
 * than being used as someone else's token.
 *
 * Format: `v1.<iv>.<ciphertext>.<tag>`, base64url. The version prefix leaves
 * room for a key rotation later.
 *
 * The same key also seals the short-lived OAuth state cookie, under a subkey
 * derived with HKDF, so a sealed cookie can never decrypt as a token or the
 * other way round.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class TokenKeyError extends Error {
  constructor() {
    super("INTEGRATION_TOKEN_KEY must be 32 bytes, base64 or hex encoded.");
    this.name = "TokenKeyError";
  }
}

/** The raw 32-byte key from its encoded form; throws TokenKeyError otherwise. */
export function parseTokenKey(encoded: string): Buffer {
  const value = encoded.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new TokenKeyError();
  return key;
}

/** A 32-byte subkey of `key` for one purpose, so no two uses share a key. */
export function deriveKey(key: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `doqtri:${purpose}`, 32));
}

/** Encrypts `plaintext`, bound to `context`. */
export function encryptSecret(plaintext: string, key: Buffer, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/**
 * The plaintext of a value encryptSecret() made with the same key and
 * context, or null when it was made with another key or context, is
 * malformed, or was tampered with.
 */
export function decryptSecret(sealed: string | null | undefined, key: Buffer, context: string): string | null {
  const parts = sealed?.split(".") ?? [];
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const body = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
