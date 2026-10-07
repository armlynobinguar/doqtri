import { afterEach, describe, expect, it, vi } from "vitest";
import { adminEntries, isAdmin } from "./admin";

const ID = "11111111-1111-4111-8111-111111111111";

describe("isAdmin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is nobody when DOQTRI_ADMINS is unset or empty", () => {
    vi.stubEnv("DOQTRI_ADMINS", "");
    expect(isAdmin({ id: ID, email: "a@example.com" })).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });

  it("matches a user id or an email, ignoring case and spaces", () => {
    vi.stubEnv("DOQTRI_ADMINS", ` ${ID.toUpperCase()} , Boss@Example.com `);
    expect(isAdmin({ id: ID, email: undefined })).toBe(true);
    expect(isAdmin({ id: "other", email: "boss@example.com" })).toBe(true);
    expect(isAdmin({ id: "other", email: "someone@example.com" })).toBe(false);
  });

  it("parses a comma-separated list", () => {
    expect([...adminEntries("a, ,B,")]).toEqual(["a", "b"]);
  });
});
