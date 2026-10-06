import { describe, expect, it } from "vitest";
import { passkeyUserName } from "./passkey-wallet";

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
