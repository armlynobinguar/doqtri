import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CHALLENGE_TTL_MS, createWalletChallenge, verifyWalletChallenge } from "./wallet-challenge";

const SECRET = "test-service-role-secret";
const sign = (kp: Keypair, message: string) => Buffer.from(kp.signMessage(message)).toString("base64");

describe("wallet challenge", () => {
  const owner = Keypair.random();
  const address = owner.publicKey();

  it("accepts a signature from the wallet the challenge was issued to", () => {
    const ch = createWalletChallenge(address, SECRET);
    expect(ch.message).toContain(address);
    expect(verifyWalletChallenge({ address, token: ch.token, signature: sign(owner, ch.message) }, SECRET)).toEqual({ ok: true });
  });

  it("rejects an address with no signature at all (the old sign-in)", () => {
    const ch = createWalletChallenge(address, SECRET);
    expect(verifyWalletChallenge({ address, token: ch.token, signature: "" }, SECRET)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a signature from a different wallet", () => {
    const ch = createWalletChallenge(address, SECRET);
    const attacker = Keypair.random();
    expect(verifyWalletChallenge({ address, token: ch.token, signature: sign(attacker, ch.message) }, SECRET)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a challenge issued to another address", () => {
    const attacker = Keypair.random();
    const ch = createWalletChallenge(attacker.publicKey(), SECRET);
    expect(verifyWalletChallenge({ address, token: ch.token, signature: sign(attacker, ch.message) }, SECRET)).toEqual({
      ok: false,
      reason: "wrong-address",
    });
  });

  it("rejects an expired challenge", () => {
    const issued = Date.now();
    const ch = createWalletChallenge(address, SECRET, issued);
    const later = issued + CHALLENGE_TTL_MS + 1;
    expect(verifyWalletChallenge({ address, token: ch.token, signature: sign(owner, ch.message) }, SECRET, later)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a token that was edited or forged", () => {
    const ch = createWalletChallenge(address, SECRET);
    const [body, tag] = ch.token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ a: address, n: "x", e: Date.now() + 1e9 })).toString("base64url");
    const signature = sign(owner, ch.message);
    expect(verifyWalletChallenge({ address, token: `${forgedBody}.${tag}`, signature }, SECRET).ok).toBe(false);
    expect(verifyWalletChallenge({ address, token: ch.token, signature }, "other-secret")).toEqual({ ok: false, reason: "tampered" });
    expect(verifyWalletChallenge({ address, token: body, signature }, SECRET)).toEqual({ ok: false, reason: "malformed" });
  });
});
