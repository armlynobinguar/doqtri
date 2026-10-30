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
 * Format: `v1.<iv>.<ciphertext>.<tag>`, base64url.
 *
 * Rotation (D-67) is a two-key ring: INTEGRATION_TOKEN_KEY is the current
 * key and INTEGRATION_TOKEN_KEY_PREVIOUS, while set, the one it replaced.
 * Everything is encrypted under the current key; a value is opened with the
 * current key and then the previous one, and the next write of it (a token
 * refresh) seals it under the current key again.
 *
 * The same key also seals the short-lived OAuth state cookie, under a subkey
 * derived with HKDF, so a sealed cookie can never decrypt as a token or the
 * other way round.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class TokenKeyError extends Error {
  constructor(name = "INTEGRATION_TOKEN_KEY") {
    super(`${name} must be 32 bytes, base64 or hex encoded.`);
    this.name = "TokenKeyError";
  }
}

/** The raw 32-byte key from its encoded form; throws TokenKeyError (naming `name`) otherwise. */
export function parseTokenKey(encoded: string, name?: string): Buffer {
  const value = encoded.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new TokenKeyError(name);
  return key;
}

/** The current key, and while a rotation is under way the key it replaced (D-67). */
export type TokenKeyRing = { current: Buffer; previous: Buffer | null };

/** A ring for `keys`: a lone key is a ring with no previous key. */
export function asKeyRing(keys: Buffer | TokenKeyRing): TokenKeyRing {
  return Buffer.isBuffer(keys) ? { current: keys, previous: null } : keys;
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

/**
 * decryptSecret() under a ring: the current key first, then the previous
 * one. `previousKey` says only the previous key opened it, so it is due to
 * be sealed again under the current one. Null when neither key opens it.
 */
export function openSecret(
  sealed: string | null | undefined,
  keys: Buffer | TokenKeyRing,
  context: string,
): { plaintext: string; previousKey: boolean } | null {
  const ring = asKeyRing(keys);
  const current = decryptSecret(sealed, ring.current, context);
  if (current !== null) return { plaintext: current, previousKey: false };
  const previous = ring.previous ? decryptSecret(sealed, ring.previous, context) : null;
  return previous === null ? null : { plaintext: previous, previousKey: true };
}
