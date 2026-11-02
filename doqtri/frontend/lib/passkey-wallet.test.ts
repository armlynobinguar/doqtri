import { describe, expect, it } from "vitest";
import { paidWriteFromRelay, passkeyUserName } from "./passkey-wallet";

/** What smart-account-kit 0.8.0 turns the name into before WebAuthn sees it. */
const kitUserId = (name: string) => `${name}:${Date.now()}:${0.12345678901234567}`;
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("passkey user name", () => {
  it("keeps short emails as they are", () => {
    expect(passkeyUserName("ada@example.com")).toBe("ada@example.com");
  });

  it("keeps every kit user id within WebAuthn's 64-byte limit", () => {
    for (const email of [
      "e2e-passkey-1791327333271@doqtri.test",
      "a.very.long.name.indeed@subdomain.example.co.uk",
      "名前がとても長いユーザー@例え.テスト",
    ]) {
      const name = passkeyUserName(email);
      expect(bytes(name)).toBeLessThanOrEqual(28);
      expect(bytes(kitUserId(name))).toBeLessThanOrEqual(64);
      expect(name.endsWith("...")).toBe(true);
    }
  });
});

describe("the relay's answer to a paid write", () => {
  const hash = "ab".repeat(32);

  it("takes a 202 as pending, not as a failure (DOQ-5)", () => {
    expect(
      paidWriteFromRelay({ ok: true, status: 202 }, { success: true, data: { hash, status: "pending", feeStroops: "51000" } }),
    ).toEqual({ hash, feeStroops: BigInt(51_000), pending: true });
  });

  it("takes a 200 as confirmed", () => {
    expect(
      paidWriteFromRelay({ ok: true, status: 200 }, { success: true, data: { hash, status: "confirmed", feeStroops: "51000" } }),
    ).toEqual({ hash, feeStroops: BigInt(51_000), pending: false });
  });

  it("throws the relay's error for a refusal", () => {
    expect(() => paidWriteFromRelay({ ok: false, status: 502 }, { success: false, error: "The transaction failed on-chain." })).toThrow(
      "The transaction failed on-chain.",
    );
    expect(() => paidWriteFromRelay({ ok: true, status: 200 }, {})).toThrow("The write could not be submitted.");
  });
});
