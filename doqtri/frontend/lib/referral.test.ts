import { describe, expect, it } from "vitest";
import {
  createReferralCookie,
  normalizeReferralCode,
  readReferralCookie,
  REFERRAL_TTL_MS,
  referralUrl,
} from "./referral";

const SECRET = "test-service-role-secret";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

describe("referral codes", () => {
  it("accepts 8 characters from the unambiguous alphabet, any case", () => {
    expect(normalizeReferralCode("k7m2pq9x")).toBe("k7m2pq9x");
    expect(normalizeReferralCode(" K7M2PQ9X ")).toBe("k7m2pq9x");
  });

  it("rejects the wrong length, look-alike characters and junk", () => {
    for (const bad of ["k7m2pq9", "k7m2pq9xy", "k7m2pq90", "k7m2pq9l", "k7m2pqio", "k7m2-q9x", "", null, undefined]) {
      expect(normalizeReferralCode(bad)).toBeNull();
    }
  });

  it("builds the shareable link", () => {
    expect(referralUrl("https://doqtri.app", "k7m2pq9x")).toBe("https://doqtri.app/r/k7m2pq9x");
    expect(referralUrl("http://localhost:3000/", "k7m2pq9x")).toBe("http://localhost:3000/r/k7m2pq9x");
  });
});

describe("referral cookie", () => {
  const cookie = createReferralCookie("k7m2pq9x", NOW, SECRET);

  it("reads back the code and when the link was opened", () => {
    expect(readReferralCookie(cookie, SECRET, NOW + 1000)).toEqual({ code: "k7m2pq9x", openedAt: NOW });
  });

  it("rejects a backdated open time", () => {
    const [code, , signature] = cookie.split(".");
    expect(readReferralCookie(`${code}.${NOW - 86_400_000}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("rejects a swapped code", () => {
    const [, openedAt, signature] = cookie.split(".");
    expect(readReferralCookie(`abcdefgh.${openedAt}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("rejects a cookie signed with another secret", () => {
    expect(readReferralCookie(createReferralCookie("k7m2pq9x", NOW, "other"), SECRET, NOW)).toBeNull();
  });

  it("expires after the TTL and refuses times in the future", () => {
    expect(readReferralCookie(cookie, SECRET, NOW + REFERRAL_TTL_MS - 1)).not.toBeNull();
    expect(readReferralCookie(cookie, SECRET, NOW + REFERRAL_TTL_MS + 1)).toBeNull();
    expect(readReferralCookie(createReferralCookie("k7m2pq9x", NOW + 5 * 60_000, SECRET), SECRET, NOW)).toBeNull();
  });

  it("rejects malformed values", () => {
    for (const bad of ["", "k7m2pq9x", "k7m2pq9x.123", "K7M2PQ9X.1.x", "k7m2pq9x.abc.x", "a.b.c.d", null, undefined]) {
      expect(readReferralCookie(bad, SECRET, NOW)).toBeNull();
    }
  });
});
