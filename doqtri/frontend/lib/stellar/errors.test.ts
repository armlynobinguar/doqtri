import { describe, expect, it } from "vitest";
import { mapWalletError } from "./errors";

const hostError = (code: number) => new Error(`HostError: Error(Contract, #${code})\nEvent log (newest first): ...`);

describe("mapWalletError", () => {
  it("reads the registry's workspace errors by exact code", () => {
    expect(mapWalletError(hostError(10)).code).toBe("NOT_EDITOR");
    expect(mapWalletError(hostError(7)).code).toBe("WORKSPACE_NOT_FOUND");
    expect(mapWalletError(hostError(13)).code).toBe("TOO_MANY_MEMBERS");
  });

  it("no longer mistakes #10-#13 for #1 (DocumentAlreadyExists)", () => {
    for (const code of [10, 11, 12, 13]) expect(mapWalletError(hostError(code)).code).not.toBe("ALREADY_EXISTS");
    expect(mapWalletError(hostError(1)).code).toBe("ALREADY_EXISTS");
    expect(mapWalletError(hostError(2)).code).toBe("NOT_FOUND");
    expect(mapWalletError(hostError(3)).code).toBe("NODE_NOT_FOUND");
  });
});
