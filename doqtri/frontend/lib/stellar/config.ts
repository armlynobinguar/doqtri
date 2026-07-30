function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** Public testnet DoqtriRegistry — override via NEXT_PUBLIC_* in .env.local / Vercel */
const TESTNET_CONTRACT =
  "CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB";

export const MAINNET_PASSPHRASE =
  "Public Global Stellar Network ; September 2015";

export const NETWORK_PASSPHRASE = env(
  "NEXT_PUBLIC_NETWORK_PASSPHRASE",
  "Test SDF Network ; September 2015",
);

/**
 * Every other network-dependent value derives from the passphrase, so a single
 * env var flips the whole app. Setting the passphrase without the matching
 * contract ID / RPC URL is the one combination that cannot be defaulted.
 */
export const IS_MAINNET = NETWORK_PASSPHRASE === MAINNET_PASSPHRASE;

export const RPC_URL = env(
  "NEXT_PUBLIC_SOROBAN_RPC_URL",
  IS_MAINNET ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org",
);

export const CONTRACT_ID = (() => {
  const id = process.env.NEXT_PUBLIC_CONTRACT_ID;
  if (id) return id;
  if (IS_MAINNET) {
    throw new Error(
      "NEXT_PUBLIC_CONTRACT_ID is required when NEXT_PUBLIC_NETWORK_PASSPHRASE is mainnet — " +
        "refusing to fall back to the testnet contract.",
    );
  }
  return TESTNET_CONTRACT;
})();

export const HORIZON_URL = env(
  "NEXT_PUBLIC_HORIZON_URL",
  IS_MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org",
);

/** stellar.expert and Stellar Lab disagree on the mainnet slug: `public` vs `mainnet`. */
const EXPERT_NETWORK = env(
  "NEXT_PUBLIC_EXPERT_NETWORK",
  IS_MAINNET ? "public" : "testnet",
);
const LAB_NETWORK = env(
  "NEXT_PUBLIC_LAB_NETWORK",
  IS_MAINNET ? "mainnet" : "testnet",
);

export const EXPERT_TX_BASE = env(
  "NEXT_PUBLIC_EXPERT_TX_BASE",
  `https://stellar.expert/explorer/${EXPERT_NETWORK}/tx`,
);

export function expertTxUrl(hash: string) {
  return `${EXPERT_TX_BASE}/${hash}`;
}

export function labContractUrl(id = CONTRACT_ID) {
  return `https://lab.stellar.org/r/${LAB_NETWORK}/contract/${id}`;
}
