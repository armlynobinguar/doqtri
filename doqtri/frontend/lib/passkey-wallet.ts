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
import { NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import {
  RELAY_PATH,
  SMART_ACCOUNT_WASM_HASH,
  THRESHOLD_POLICY,
  WEBAUTHN_VERIFIER,
} from "@/lib/stellar/smart-wallet-config";

type Kit = InstanceType<typeof import("smart-account-kit").SmartAccountKit>;

let kitPromise: Promise<Kit> | null = null;

async function kit(): Promise<Kit> {
  if (typeof window === "undefined") throw new Error("Passkey wallets need a browser.");
  kitPromise ??= import("smart-account-kit").then(
    ({ SmartAccountKit }) =>
      new SmartAccountKit({
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        accountWasmHash: SMART_ACCOUNT_WASM_HASH,
        webauthnVerifierAddress: WEBAUTHN_VERIFIER,
        rpName: "Doqtri",
        relayerUrl: RELAY_PATH,
        // Supabase (smart_wallets, wallet_passkeys) is the index, not Mercury.
        indexerUrl: false,
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
    result = await (await kit()).createWallet("Doqtri", email, {
      autoSubmit: true,
      authenticatorSelection: { residentKey: "required" },
      policies: [{ address: THRESHOLD_POLICY, type: "threshold", installParams: { threshold: 1 } }],
    });
  } catch (error) {
    throw new Error(passkeyErrorMessage(error));
  }
  if (!result.submitResult?.success) {
    throw new Error(result.submitResult?.error?.message || "Your wallet could not be created. Try again.");
  }
  return { address: result.contractId };
}

/** WebAuthn errors are DOMExceptions with terse names; say what happened. */
function passkeyErrorMessage(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError") return "Passkey creation was cancelled.";
  if (name === "InvalidStateError") return "This device already has a passkey for that account.";
  if (name === "SecurityError") return "Passkeys aren't allowed on this address. Open Doqtri at its usual web address.";
  return error instanceof Error && error.message ? error.message : "Your wallet could not be created. Try again.";
}
