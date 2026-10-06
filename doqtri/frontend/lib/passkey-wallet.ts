"use client";

/**
 * Passkey smart wallets in the browser (progress/002).
 *
 * smart-account-kit runs the WebAuthn ceremony and builds the deploy; the
 * relay (/api/chain/relay) validates it and submits it through Channels, so
 * the user pays nothing and never sees XLM. Like lib/wallet.ts, the kit is
 * imported lazily: it touches browser-only APIs and is only needed when an
 * email user creates or uses a wallet.
 */
import type { contract } from "@stellar/stellar-sdk";
import { HORIZON_URL, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import {
  INDEXER_PATH,
  RELAY_PATH,
  SMART_ACCOUNT_WASM_HASH,
  THRESHOLD_POLICY,
  WEBAUTHN_VERIFIER,
} from "@/lib/stellar/smart-wallet-config";

type Kit = InstanceType<typeof import("smart-account-kit").SmartAccountKit>;

/** Threshold 1: any one of the wallet's passkeys can sign (backups, phase 7). */
const WALLET_POLICY = { address: THRESHOLD_POLICY, type: "threshold" as const, installParams: { threshold: 1 } };

let kitPromise: Promise<Kit> | null = null;

async function kit(): Promise<Kit> {
  if (typeof window === "undefined") throw new Error("Passkey wallets need a browser.");
  kitPromise ??= import("smart-account-kit").then(
    ({ SmartAccountKit, IndexedDBStorage }) =>
      new SmartAccountKit({
        // Keeps the verified connection across reloads (the kit's session
        // lasts 7 days), so a returning user's next write needs one passkey
        // prompt to sign instead of a second one to re-prove ownership.
        storage: new IndexedDBStorage(),
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        accountWasmHash: SMART_ACCOUNT_WASM_HASH,
        webauthnVerifierAddress: WEBAUTHN_VERIFIER,
        rpName: "Doqtri",
        // Installed on every new wallet, and what the kit expects to find in a
        // wallet's constructor when it verifies the wallet before signing.
        defaultPolicies: [WALLET_POLICY],
        relayerUrl: RELAY_PATH,
        // Supabase (smart_wallets, wallet_passkeys) is the index, not Mercury.
        // The kit re-verifies every birth claim it gets from here on-chain.
        indexerUrl: INDEXER_PATH,
        // Creation transactions older than RPC's retention are read from here.
        horizonUrl: HORIZON_URL,
      }),
  );
  return kitPromise;
}

/** True when this browser can create and use passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

/**
 * Creates the passkey and deploys the wallet it controls. One biometric
 * prompt. Resolves once the deploy is confirmed on-chain and recorded.
 */
export async function createPasskeyWallet(email: string): Promise<{ address: string }> {
  if (!passkeysSupported()) {
    throw new Error("This browser can't create passkeys. Try a recent Chrome, Safari, Edge, or Firefox.");
  }
  let result;
  try {
    result = await (await kit()).createWallet("Doqtri", passkeyUserName(email), {
      autoSubmit: true,
      authenticatorSelection: { residentKey: "required" },
    });
  } catch (error) {
    throw new Error(passkeyErrorMessage(error, "Your wallet could not be created. Try again."));
  }
  if (!result.submitResult?.success) {
    throw new Error(result.submitResult?.error?.message || "Your wallet could not be created. Try again.");
  }
  return { address: result.contractId };
}

/**
 * The kit makes the WebAuthn user id from `${userName}:${Date.now()}:${Math.random()}`
 * and WebAuthn rejects ids over 64 bytes ("User ID was not between 1 and 64
 * characters"). The timestamp and random number take up to ~35 bytes, so the
 * name — which the passkey picker also shows — is capped at 28 bytes.
 */
export function passkeyUserName(email: string, maxBytes = 28): string {
  const encoder = new TextEncoder();
  if (encoder.encode(email).length <= maxBytes) return email;
  let name = email;
  while (encoder.encode(`${name}...`).length > maxBytes) name = name.slice(0, -1);
  return `${name}...`;
}

/** WebAuthn errors are DOMExceptions with terse names; say what happened. */
function passkeyErrorMessage(error: unknown, fallback: string): string {
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError") return "The passkey prompt was cancelled.";
  if (name === "InvalidStateError") return "This device already has a passkey for that account.";
  if (name === "SecurityError") return "Passkeys aren't allowed on this address. Open Doqtri at its usual web address.";
  return error instanceof Error && error.message ? error.message : fallback;
}

/** What the browser needs to sign as an email user's wallet. */
export type PasskeyWalletRef = { address: string; credentialId: string };

/**
 * The signed-in user's wallet, set by WalletProvider from the server-loaded
 * identity. The registry client only receives an address (`C…`), the same
 * way it does for Freighter, and looks the passkey up here.
 */
let current: PasskeyWalletRef | null = null;

export function setPasskeyWallet(wallet: PasskeyWalletRef | null): void {
  current = wallet;
}

export function passkeyWalletFor(address: string): PasskeyWalletRef {
  if (!current || current.address !== address) {
    throw new Error("This passkey wallet isn't the one signed in here. Reload and try again.");
  }
  return current;
}

/**
 * Signs `tx`'s auth entry for the wallet with its passkey and relays it; the
 * relay validates, pays, submits, and waits for the ledger. Returns the hash.
 *
 * `tx` must be built without a `publicKey`: the wallet only authorizes the
 * call, and Channels supplies the transaction source and fee.
 */
export async function signAndRelay<T>(tx: contract.AssembledTransaction<T>, wallet: PasskeyWalletRef): Promise<string> {
  const k = await kit();
  try {
    // After a reload the kit's in-memory session is empty; reconnect to the
    // wallet Supabase recorded for this user.
    if (k.contractId !== wallet.address || k.credentialId !== wallet.credentialId) {
      await k.connectWallet({ contractId: wallet.address, credentialId: wallet.credentialId });
    }
  } catch (error) {
    throw new Error(passkeyErrorMessage(error, "Your passkey wallet could not be opened."));
  }
  let result;
  try {
    result = await k.signAndSubmit(tx, { credentialId: wallet.credentialId });
  } catch (error) {
    throw new Error(passkeyErrorMessage(error, "Signing with your passkey failed."));
  }
  if (!result.success) throw new Error(result.error?.message || "The transaction could not be submitted.");
  return result.hash;
}
