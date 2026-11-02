import { createHash, createPublicKey, verify, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSoftPasskey, restoreSoftPasskey, saveSoftPasskey, softWebAuthn } from "./soft-passkey";

const ORIGIN = "http://localhost:3000";
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

/** The 65-byte point as the P-256 public key a verifier would import. */
function keyFromPoint(point: Buffer) {
  return createPublicKey({
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") },
    format: "jwk",
  });
}

describe("software passkey", () => {
  it("survives the state file", () => {
    const passkey = createSoftPasskey();
    const restored = restoreSoftPasskey(JSON.parse(JSON.stringify(saveSoftPasskey(passkey))));
    expect(restored.credentialId).toBe(passkey.credentialId);
    expect(restored.publicKey.equals(passkey.publicKey)).toBe(true);
    expect(passkey.publicKey).toHaveLength(65);
    expect(passkey.publicKey[0]).toBe(0x04);
  });

  it("registers with an SPKI public key the kit can read back as the same point", async () => {
    const passkey = createSoftPasskey();
    const reg = await softWebAuthn(passkey, ORIGIN).startRegistration({
      optionsJSON: {
        challenge: "Y2hhbGxlbmdl",
        rp: { id: "localhost", name: "Doqtri" },
        user: { id: "dXNlcg", name: "loadtest", displayName: "loadtest" },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      },
    });
    expect(reg.id).toBe(passkey.credentialId);
    // What smart-account-kit's extractPublicKeyFromAttestation does with it.
    const imported = await webcrypto.subtle.importKey(
      "spki",
      Buffer.from(reg.response.publicKey!, "base64url"),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      [],
    );
    expect(Buffer.from(await webcrypto.subtle.exportKey("raw", imported)).equals(passkey.publicKey)).toBe(true);
  });

  it("signs an assertion the way the WebAuthn verifier checks it", async () => {
    const passkey = createSoftPasskey();
    const challenge = sha256("auth digest").toString("base64url");
    const res = await softWebAuthn(passkey, ORIGIN).startAuthentication({
      optionsJSON: { challenge, rpId: "localhost", allowCredentials: [{ id: passkey.credentialId, type: "public-key" }] },
    });
    const authData = Buffer.from(res.response.authenticatorData, "base64url");
    const clientData = Buffer.from(res.response.clientDataJSON, "base64url");

    expect(JSON.parse(clientData.toString())).toEqual({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false });
    expect(authData.subarray(0, 32).equals(sha256("localhost"))).toBe(true);
    expect(authData[32] & 0x05).toBe(0x05); // user present and verified
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const signature = Buffer.from(res.response.signature, "base64url");
    expect(signature[0]).toBe(0x30); // DER, as authenticators return it
    expect(verify("sha256", signed, { key: keyFromPoint(passkey.publicKey), dsaEncoding: "der" }, signature)).toBe(true);
  });

  it("refuses a ceremony that names only other passkeys", async () => {
    const res = softWebAuthn(createSoftPasskey(), ORIGIN).startAuthentication({
      optionsJSON: { challenge: "Y2hhbGxlbmdl", allowCredentials: [{ id: "c29tZW9uZS1lbHNl", type: "public-key" }] },
    });
    await expect(res).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});
