import { describe, expect, it } from "vitest";
import {
  FORMER_PERSONAL_WORKSPACE_NOTE,
  FORMER_USER,
  isFormerPersonalWorkspace,
  templateAuthor,
} from "./former-user";

const WALLET = "C" + "A".repeat(54) + "Z";

describe("a deleted account (D-63)", () => {
  it("is called Former user", () => {
    expect(FORMER_USER).toBe("Former user");
  });

  it("credits a template to its wallet alone while the creator's account exists", () => {
    expect(templateAuthor({ creatorWallet: WALLET })).toBe("CAAA…AAAZ");
    expect(templateAuthor({ creatorWallet: WALLET, creatorGone: false })).toBe("CAAA…AAAZ");
  });

  it("names a deleted creator Former user, and keeps the wallet beside it", () => {
    expect(templateAuthor({ creatorWallet: WALLET, creatorGone: true })).toBe("Former user · CAAA…AAAZ");
  });

  it("marks only a personal workspace whose creator is gone", () => {
    expect(isFormerPersonalWorkspace({ is_personal: true, created_by: null })).toBe(true);
    expect(isFormerPersonalWorkspace({ is_personal: true, created_by: "u" })).toBe(false);
    // A team workspace whose creator left keeps created_by null too; it has an owner.
    expect(isFormerPersonalWorkspace({ is_personal: false, created_by: null })).toBe(false);
  });

  it("tells members of such a workspace that it stays without an owner", () => {
    expect(FORMER_PERSONAL_WORKSPACE_NOTE).toBe(
      "This was the personal workspace of a former user, who deleted their account. Its notes stay here and " +
        "members keep their roles, but nobody owns it any more and nobody can become its owner.",
    );
  });
});
