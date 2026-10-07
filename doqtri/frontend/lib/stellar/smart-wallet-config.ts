/**
 * Passkey smart wallets for email accounts (progress/002).
 *
 * Doqtri uploads no wallet code of its own. Each wallet is an instance of the
 * OpenZeppelin smart account that SDF deployed canonically on both networks
 * (smart-account-kit docs/deployments-protocol-27-2026-07-09.md, built from
 * OpenZeppelin/stellar-contracts@1e513890). The account wasm hash is the same
 * on testnet and mainnet; the verifier and policy are per-network contracts.
 */
import { Asset } from "@stellar/stellar-sdk";
import { IS_MAINNET, NETWORK_PASSPHRASE } from "@/lib/stellar/config";

export type StellarNetwork = "testnet" | "mainnet";

export const NETWORK: StellarNetwork = IS_MAINNET ? "mainnet" : "testnet";

const CONTRACTS = {
  testnet: {
    webauthnVerifier: "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F",
    thresholdPolicy: "CB3FATQKCIRIQOCYRUPCQ2KREQ7T4RPKS7EAEOZWPEPUKWEDRVROBCEG",
  },
  mainnet: {
    webauthnVerifier: "CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR",
    thresholdPolicy: "CCEJBH26V7REDWKKAV5TYF3M7NF2OZBELBK2DZTVX3BRNEPVCOAZXJUF",
  },
} as const;

export const SMART_ACCOUNT_WASM_HASH =
  "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a";

export const WEBAUTHN_VERIFIER = CONTRACTS[NETWORK].webauthnVerifier;

/**
 * Installed with threshold 1 on the wallet's default rule. A rule without a
 * policy requires *every* signer, so without it a backup passkey would make
 * both passkeys mandatory for each signature.
 */
export const THRESHOLD_POLICY = CONTRACTS[NETWORK].thresholdPolicy;

/**
 * smart-account-kit's shared deterministic deployer seed (its
 * DEFAULT_DEPLOYER_SEED, not exported). The deployer only salts the deploy and
 * signs its authorization; it never pays fees or controls the wallet. Using
 * the shared one keeps wallet addresses derivable from the credential id alone.
 */
export const SHARED_DEPLOYER_SEED = "openzeppelin-smart-account-kit";

/** The relay route the kit posts `{ func, auth }` to. */
export const RELAY_PATH = "/api/chain/relay";

/** The kit appends `/api/lookup/<credential hex>` (app/api/chain/indexer/…). */
export const INDEXER_PATH = "/api/chain/indexer";

// ---------------------------------------------------------------------------
// User-paid fees (progress/003). Testnet only for now: on a network without a
// forwarder, email users' writes stay sponsored through Channels.

/** Doqtri's FeeForwarder (fee-forwarder/, OpenZeppelin fee abstraction). */
const FORWARDERS: Partial<Record<StellarNetwork, string>> = {
  testnet: "CCBBXJSS7DUT34QDJOMZLAYMYOT4Q73NUSY573G4STXFUBSYXDKUBUHV",
};

/** Doqtri's relayer account: approves each forwarded call and receives the fee. */
const RELAYERS: Partial<Record<StellarNetwork, string>> = {
  testnet: "GCY3QATELG5SQGVV56UF3RIXAFELDQTHP2PFLGG3SFJJETCGBEFUDB5M",
};

export const FEE_FORWARDER: string | null = FORWARDERS[NETWORK] ?? null;
export const DOQTRI_RELAYER: string | null = RELAYERS[NETWORK] ?? null;

/** The native XLM token contract on this network: what users pay fees in. */
export const NATIVE_XLM = Asset.native().contractId(NETWORK_PASSPHRASE);

/** Whether email users pay their own anchoring fees on this network. */
export const USER_PAYS_FEES = FEE_FORWARDER !== null && DOQTRI_RELAYER !== null;

/**
 * The most a user signs to pay for one write: 0.5 XLM, matching the relay's
 * resource-fee cap. They are charged the actual cost, never more than this.
 */
export const MAX_USER_FEE_STROOPS = BigInt(5_000_000);
