import { describe, expect, it } from "vitest";
import { confirmUrl, safeNextPath, signUpProblem } from "./email-auth";

describe("email sign-up checks", () => {
  it("accepts a normal email and a long enough password", () => {
    expect(signUpProblem("ada@example.com", "correct horse")).toBeNull();
  });

  it("refuses the synthetic wallet domain", () => {
    expect(signUpProblem("gabc@stellar.doqtri.local", "correct horse")).toMatch(/reserved/);
  });

  it("refuses short passwords and malformed emails", () => {
    expect(signUpProblem("ada@example.com", "short")).toMatch(/at least/);
    expect(signUpProblem("not-an-email", "correct horse")).toMatch(/valid email/);
  });
});

describe("post-confirmation redirect", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/reset-password")).toBe("/reset-password");
    expect(safeNextPath("/vault/abc?x=1")).toBe("/vault/abc?x=1");
  });

  it("falls back for anything that could leave the site", () => {
    for (const next of ["//evil.com", "/\\evil.com", "https://evil.com", "evil.com", "", null]) {
      expect(safeNextPath(next)).toBe("/vault");
    }
  });

  it("encodes next into the confirmation link", () => {
    expect(confirmUrl("https://doqtri.app", "/reset-password")).toBe(
      "https://doqtri.app/auth/confirm?next=%2Freset-password",
    );
  });
});
