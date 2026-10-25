import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, deriveKey, encryptSecret, openSecret, parseTokenKey, TokenKeyError } from "./token-crypto";

const key = randomBytes(32);

describe("openSecret (D-67 key ring)", () => {
  const current = randomBytes(32);
  const previous = randomBytes(32);

  it("opens with the current key, then the previous one, and says which", () => {
    const fresh = encryptSecret("rt", current, "qdit:refresh:u");
    const old = encryptSecret("rt-old", previous, "qdit:refresh:u");
    expect(openSecret(fresh, { current, previous }, "qdit:refresh:u")).toEqual({ plaintext: "rt", previousKey: false });
    expect(openSecret(old, { current, previous }, "qdit:refresh:u")).toEqual({ plaintext: "rt-old", previousKey: true });
    // A lone key is a ring with no previous key.
    expect(openSecret(fresh, current, "qdit:refresh:u")?.plaintext).toBe("rt");
    expect(openSecret(old, current, "qdit:refresh:u")).toBeNull();
  });

  it("still binds the context, and opens nothing sealed under a third key", () => {
    const old = encryptSecret("rt", previous, "qdit:refresh:u");
    expect(openSecret(old, { current, previous }, "qdit:access:u")).toBeNull();
    expect(openSecret(encryptSecret("x", randomBytes(32), "c"), { current, previous }, "c")).toBeNull();
    expect(openSecret(null, { current, previous }, "c")).toBeNull();
  });

  it("names the variable a bad key came from", () => {
    expect(() => parseTokenKey("short", "INTEGRATION_TOKEN_KEY_PREVIOUS")).toThrow(/INTEGRATION_TOKEN_KEY_PREVIOUS/);
  });
});

describe("parseTokenKey", () => {
  it("takes 32 bytes as base64 or hex", () => {
    expect(parseTokenKey(key.toString("base64")).equals(key)).toBe(true);
    expect(parseTokenKey(key.toString("hex")).equals(key)).toBe(true);
    expect(parseTokenKey(`  ${key.toString("base64")}\n`).equals(key)).toBe(true);
  });

  it("refuses anything that is not 32 bytes", () => {
    expect(() => parseTokenKey(randomBytes(16).toString("base64"))).toThrow(TokenKeyError);
    expect(() => parseTokenKey("not a key")).toThrow(TokenKeyError);
    expect(() => parseTokenKey("")).toThrow(TokenKeyError);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a token", () => {
    const sealed = encryptSecret("eyJhbGciOi.access.token", key, "qdit:access:u1");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("access.token");
    expect(decryptSecret(sealed, key, "qdit:access:u1")).toBe("eyJhbGciOi.access.token");
  });

  it("uses a fresh IV every time", () => {
    expect(encryptSecret("same", key, "c")).not.toBe(encryptSecret("same", key, "c"));
  });

  it("refuses another context: another user's row, or the other column", () => {
    const sealed = encryptSecret("token", key, "qdit:access:u1");
    expect(decryptSecret(sealed, key, "qdit:access:u2")).toBeNull();
    expect(decryptSecret(sealed, key, "qdit:refresh:u1")).toBeNull();
  });

  it("refuses another key", () => {
    expect(decryptSecret(encryptSecret("token", key, "c"), randomBytes(32), "c")).toBeNull();
  });

  it("refuses a tampered or malformed value", () => {
    const sealed = encryptSecret("token", key, "c");
    const parts = sealed.split(".");
    const flipped = Buffer.from(parts[2], "base64url");
    flipped[0] ^= 1;
    expect(decryptSecret([parts[0], parts[1], flipped.toString("base64url"), parts[3]].join("."), key, "c")).toBeNull();
    expect(decryptSecret(sealed.replace(/^v1/, "v2"), key, "c")).toBeNull();
    expect(decryptSecret("v1.a.b", key, "c")).toBeNull();
    expect(decryptSecret(null, key, "c")).toBeNull();
    expect(decryptSecret("", key, "c")).toBeNull();
  });

  it("derives distinct subkeys per purpose", () => {
    const a = deriveKey(key, "qdit-oauth-state");
    expect(a).toHaveLength(32);
    expect(a.equals(key)).toBe(false);
    expect(a.equals(deriveKey(key, "other"))).toBe(false);
    expect(decryptSecret(encryptSecret("x", a, "c"), key, "c")).toBeNull();
  });
});
