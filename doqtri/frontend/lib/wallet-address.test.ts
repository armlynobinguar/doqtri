import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { isReservedEmail, walletAddressFromEmail } from "./wallet-address";
import { walletEmail } from "./wallet-auth";

describe("wallet email identity", () => {
  const address = Keypair.random().publicKey();

  it("round-trips the synthetic email the wallet route creates", () => {
    expect(walletAddressFromEmail(walletEmail(address))).toBe(address);
  });

  it("treats a real email as an email account", () => {
    expect(walletAddressFromEmail("someone@example.com")).toBeNull();
    expect(walletAddressFromEmail(null)).toBeNull();
  });

  it("rejects a reserved-domain email whose local part is not a public key", () => {
    expect(walletAddressFromEmail("admin@stellar.doqtri.local")).toBeNull();
  });

  it("reserves the wallet domain for sign-up, case-insensitively", () => {
    expect(isReservedEmail(walletEmail(address))).toBe(true);
    expect(isReservedEmail(" X@Stellar.Doqtri.Local ")).toBe(true);
    expect(isReservedEmail("x@stellar.doqtri.local.evil.com")).toBe(false);
    expect(isReservedEmail("x@example.com")).toBe(false);
  });
});
