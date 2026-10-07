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
import { hash, TransactionBuilder, xdr, type contract } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type { WalletPasskey } from "@/lib/types";
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

type Storage = InstanceType<typeof import("smart-account-kit").IndexedDBStorage>;

let kitPromise: Promise<{ kit: Kit; storage: Storage }> | null = null;

async function kitAndStorage(): Promise<{ kit: Kit; storage: Storage }> {
  if (typeof window === "undefined") throw new Error("Passkey wallets need a browser.");
  kitPromise ??= import("smart-account-kit").then(({ SmartAccountKit, IndexedDBStorage }) => {
    // Keeps the verified connection across reloads (the kit's session lasts
    // 7 days), so a returning user's next write needs one passkey prompt to
    // sign instead of a second one to re-prove ownership.
    const storage = new IndexedDBStorage();
    return {
      storage,
      kit: new SmartAccountKit({
        storage,
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
    };
  });
  return kitPromise;
}

async function kit(): Promise<Kit> {
  return (await kitAndStorage()).kit;
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
export type PasskeyWalletRef = { address: string; createdTx: string; passkeys: WalletPasskey[] };

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
 * The wallet's creation, read from its public creation transaction: the
 * ledger it landed in and the hash of its constructor arguments (the kit's
 * `constructorArgsHash`). Channels wraps transactions in a fee bump.
 */
async function walletBirth(createdTx: string): Promise<{ ledger: number; argsHash: string }> {
  const res = await fetch(`${HORIZON_URL}/transactions/${createdTx}`);
  if (!res.ok) throw new Error("Your wallet's history could not be read right now. Try again.");
  const body = (await res.json()) as { ledger: number; envelope_xdr: string };
  const envelope = xdr.TransactionEnvelope.fromXDR(body.envelope_xdr, "base64");
  const tx =
    envelope.switch().name === "envelopeTypeTxFeeBump"
      ? envelope.feeBump().tx().innerTx().v1().tx()
      : envelope.v1().tx();
  const args = tx.operations()[0].body().invokeHostFunctionOp().hostFunction().createContractV2().constructorArgs();
  return { ledger: body.ledger, argsHash: hash(xdr.ScVal.scvVec([...args]).toXDR()).toString("hex") };
}

/**
 * The kit only connects a backup passkey on the device that added it: there
 * it keeps a local record that the passkey belongs to the wallet. On any other
 * device (the case backups exist for) it would look for a wallet derived from
 * the backup passkey and fail. So before the user picks a passkey here, write
 * those records from the server's list — which only the relay writes, after
 * the wallet itself approved each passkey on-chain. The kit still checks the
 * wallet's creation against the ledger and that the chosen passkey is a live
 * signer on the wallet; the contract still verifies every signature.
 */
async function rememberWalletPasskeys(storage: Storage, wallet: PasskeyWalletRef): Promise<void> {
  const missing: WalletPasskey[] = [];
  for (const passkey of wallet.passkeys) {
    if (!(await storage.get(passkey.credentialId))) missing.push(passkey);
  }
  if (missing.length === 0) return;
  const birth = await walletBirth(wallet.createdTx);
  for (const passkey of missing) {
    await storage.save({
      credentialId: passkey.credentialId,
      publicKey: Uint8Array.from(Buffer.from(passkey.publicKey, "hex")),
      contractId: wallet.address,
      createdAt: Date.parse(passkey.createdAt) || Date.now(),
      isPrimary: false,
      associationVerified: true,
      contextRuleId: 0,
      deploymentStatus: "deployed",
      birthWasmHash: SMART_ACCOUNT_WASM_HASH,
      creationTransactionHash: wallet.createdTx,
      creationLedger: birth.ledger,
      birthConstructorArgsHash: birth.argsHash,
    });
  }
}

/**
 * Connects the kit to `wallet` using a passkey this device can actually use,
 * and returns that passkey's credential id. The kit signs with exactly one
 * named passkey, so with backups we first have to learn which one is here:
 * 1. already connected with one of the wallet's passkeys: nothing to do;
 * 2. a stored session (IndexedDB, 7 days): silent reconnect;
 * 3. otherwise one prompt where the user picks a passkey — on this device, on
 *    a phone over the browser's QR flow, or on a security key.
 */
async function connectWith(k: Kit, wallet: PasskeyWalletRef): Promise<string> {
  const { storage } = await kitAndStorage();
  const ids = new Set(wallet.passkeys.map((p) => p.credentialId));
  const usable = () =>
    k.contractId === wallet.address && k.credentialId !== undefined && ids.has(k.credentialId);
  if (usable()) return k.credentialId!;

  try {
    await k.connectWallet();
  } catch {
    // No usable stored session; fall through to asking.
  }
  if (usable()) return k.credentialId!;

  try {
    await rememberWalletPasskeys(storage, wallet);
    await k.connectWallet({ fresh: true });
  } catch (error) {
    throw new Error(passkeyErrorMessage(error, "Your passkey wallet could not be opened."));
  }
  if (!usable()) {
    await k.disconnect().catch(() => {});
    throw new Error("That passkey isn't one of this wallet's passkeys. Choose a passkey you added to Doqtri.");
  }
  return k.credentialId!;
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
  const credentialId = await connectWith(k, wallet);
  let result;
  try {
    result = await k.signAndSubmit(tx, { credentialId });
  } catch (error) {
    throw new Error(passkeyErrorMessage(error, "Signing with your passkey failed."));
  }
  if (!result.success) throw new Error(result.error?.message || "The transaction could not be submitted.");
  return result.hash;
}

/**
 * Adds a passkey to the wallet: the browser creates it (the user picks this
 * device, a phone, or a security key), then a passkey the wallet already
 * accepts approves `add_signer`. Two prompts, plus one to pick an existing
 * passkey if this device has no session.
 */
export async function addPasskey(wallet: PasskeyWalletRef, email: string): Promise<void> {
  const k = await kit();
  await connectWith(k, wallet);
  let result;
  try {
    const { transaction } = await k.signers.addPasskey(0, "Doqtri", passkeyUserName(email));
    result = await k.signAndSubmitAdmin(transaction);
  } catch (error) {
    throw new Error(passkeyErrorMessage(error, "The passkey could not be added."));
  }
  if (!result.success) {
    // The new passkey may already exist on the device even though the wallet
    // never accepted it; it does nothing until it is added.
    throw new Error(result.error?.message || "The passkey could not be added to your wallet.");
  }
}

/** The browser `buffer` polyfill has no "base64url" encoding. */
function fromBase64Url(value: string): Buffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64");
}

/** Removes a passkey from the wallet, approved by any passkey it accepts. */
export async function removePasskey(wallet: PasskeyWalletRef, credentialId: string): Promise<void> {
  const passkey = wallet.passkeys.find((p) => p.credentialId === credentialId);
  if (!passkey) throw new Error("That passkey isn't on this wallet.");
  if (wallet.passkeys.length <= 1) throw new Error("You can't remove your only passkey.");
  const k = await kit();
  await connectWith(k, wallet);
  const keyData = Buffer.concat([Buffer.from(passkey.publicKey, "hex"), fromBase64Url(credentialId)]);
  let result;
  try {
    const transaction = await k.signers.remove(0, { tag: "External", values: [WEBAUTHN_VERIFIER, keyData] });
    result = await k.signAndSubmitAdmin(transaction);
  } catch (error) {
    throw new Error(passkeyErrorMessage(error, "The passkey could not be removed."));
  }
  if (!result.success) throw new Error(result.error?.message || "The passkey could not be removed.");
}
