import { afterEach, describe, expect, it, vi } from "vitest";
import { legalOperatorName, legalPagesLive } from "./legal";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the legal pages gate", () => {
  it("is off when the variable is unset", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", undefined);
    expect(legalOperatorName()).toBeNull();
    expect(legalPagesLive()).toBe(false);
  });

  it("is off when the variable is empty or only whitespace", () => {
    for (const value of ["", "   ", "\n\t "]) {
      vi.stubEnv("LEGAL_OPERATOR_NAME", value);
      expect(legalOperatorName()).toBeNull();
      expect(legalPagesLive()).toBe(false);
    }
  });

  it("is on when set, and the name comes back trimmed", () => {
    vi.stubEnv("LEGAL_OPERATOR_NAME", "  Test Operator ");
    expect(legalOperatorName()).toBe("Test Operator");
    expect(legalPagesLive()).toBe(true);
  });
});
