/**
 * A software passkey for the paid-write load test (DOQ-2, WP-4.1).
 *
 * Email accounts' wallets are controlled by a WebAuthn (secp256r1) passkey,
 * and a headless load test has no authenticator to tap. smart-account-kit
 * takes its WebAuthn calls as an injectable `webAuthn` option ("for
 * testing"), so this stands in for @simplewebauthn/browser with a P-256 key
 * held in memory. Everything downstream is the real thing: the kit builds the
 * deploy and the auth payload exactly as in the browser, the relay validates
 * them, and the wallet contract's WebAuthn verifier checks each signature
 * on-chain like a hardware passkey's.
 *
 * Test wallets only: the private key sits in a local state file.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/** What a test wallet keeps between runs. */
export type SavedSoftPasskey = { credentialId: string; privateKeyPkcs8: string };

export type SoftPasskey = {
  /** base64url, as WebAuthn and the kit spell credential ids. */
  credentialId: string;
  /** Uncompressed P-256 point (0x04 || x || y), as the wallet stores it. */
  publicKey: Buffer;
  privateKey: KeyObject;
};

/** User present (0x01) and user verified (0x04): what the kit asks for. */
const FLAGS_UP_UV = 0x05;

export function createSoftPasskey(): SoftPasskey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return fromPrivateKey(randomBytes(16).toString("base64url"), privateKey);
}

export function restoreSoftPasskey(saved: SavedSoftPasskey): SoftPasskey {
  const key = createPrivateKey({ key: Buffer.from(saved.privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" });
  return fromPrivateKey(saved.credentialId, key);
}

export function saveSoftPasskey(passkey: SoftPasskey): SavedSoftPasskey {
  return {
    credentialId: passkey.credentialId,
    privateKeyPkcs8: passkey.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

function fromPrivateKey(credentialId: string, privateKey: KeyObject): SoftPasskey {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return { credentialId, publicKey, privateKey };
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

/** rpIdHash || flags || signCount (always 0, as many platform passkeys report). */
export function authenticatorData(rpId: string): Buffer {
  return Buffer.concat([sha256(rpId), Buffer.from([FLAGS_UP_UV]), Buffer.alloc(4)]);
}

/** Client data in the browser's own key order; the verifier reads `type` and `challenge`. */
export function clientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/** A DER ECDSA signature over authenticatorData || sha256(clientDataJSON), as authenticators return it. */
export function assertionSignature(passkey: SoftPasskey, authData: Buffer, clientData: Buffer): Buffer {
  return sign("sha256", Buffer.concat([authData, sha256(clientData)]), { key: passkey.privateKey, dsaEncoding: "der" });
}

/**
 * The kit's `webAuthn` option, answering every ceremony with `passkey`.
 * Registration hands back the public key the kit reads (`response.publicKey`,
 * SPKI); the attestation object is left empty because neither the kit nor the
 * relay parses it. `origin` is the deployment under test.
 */
export function softWebAuthn(passkey: SoftPasskey, origin: string) {
  const rpIdOf = (rpId: string | undefined) => rpId ?? new URL(origin).hostname;
  return {
    async startRegistration({ optionsJSON }: { optionsJSON: PublicKeyCredentialCreationOptionsJSON }): Promise<RegistrationResponseJSON> {
      const spki = createPublicKey(passkey.privateKey).export({ format: "der", type: "spki" });
      return {
        id: passkey.credentialId,
        rawId: passkey.credentialId,
        type: "public-key",
        response: {
          clientDataJSON: clientDataJSON("webauthn.create", optionsJSON.challenge, origin).toString("base64url"),
          attestationObject: "",
          authenticatorData: authenticatorData(rpIdOf(optionsJSON.rp.id)).toString("base64url"),
          publicKey: spki.toString("base64url"),
          publicKeyAlgorithm: -7,
          transports: ["internal"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
    async startAuthentication({ optionsJSON }: { optionsJSON: PublicKeyCredentialRequestOptionsJSON }): Promise<AuthenticationResponseJSON> {
      const allowed = optionsJSON.allowCredentials;
      if (allowed?.length && !allowed.some((c) => c.id === passkey.credentialId)) {
        throw Object.assign(new Error("The software passkey is not among the allowed credentials."), { name: "NotAllowedError" });
      }
      const authData = authenticatorData(rpIdOf(optionsJSON.rpId));
      const clientData = clientDataJSON("webauthn.get", optionsJSON.challenge, origin);
      return {
        id: passkey.credentialId,
        rawId: passkey.credentialId,
        type: "public-key",
        response: {
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: assertionSignature(passkey, authData, clientData).toString("base64url"),
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}
