/**
 * Next.js only inlines statically-written `process.env.NEXT_PUBLIC_*` reads into
 * the client bundle — a dynamic `process.env[name]` lookup is left untouched and
 * evaluates to undefined in the browser. Every public var must therefore be
 * spelled out literally, once, right here.
 */
const RAW = {
  NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
  CONTRACT_ID: process.env.NEXT_PUBLIC_CONTRACT_ID,
  HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL,
  EXPERT_NETWORK: process.env.NEXT_PUBLIC_EXPERT_NETWORK,
  LAB_NETWORK: process.env.NEXT_PUBLIC_LAB_NETWORK,
  EXPERT_TX_BASE: process.env.NEXT_PUBLIC_EXPERT_TX_BASE,
} as const;

/** Dashboard values often arrive wrapped in quotes or with a stray newline. */
function env(name: keyof typeof RAW, fallback: string): string {
  const raw = RAW[name]?.trim().replace(/^["']|["']$/g, "");
  return raw || fallback;
}

/** Public testnet DoqtriRegistry — override via NEXT_PUBLIC_* in .env.local / Vercel */
const TESTNET_CONTRACT =
  "CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB";

export const MAINNET_PASSPHRASE =
  "Public Global Stellar Network ; September 2015";

export const NETWORK_PASSPHRASE = env(
  "NETWORK_PASSPHRASE",
  "Test SDF Network ; September 2015",
);

/**
 * Every other network-dependent value derives from the passphrase, so a single
 * env var flips the whole app. Setting the passphrase without the matching
 * contract ID / RPC URL is the one combination that cannot be defaulted.
 */
export const IS_MAINNET = NETWORK_PASSPHRASE === MAINNET_PASSPHRASE;

export const RPC_URL = env(
  "SOROBAN_RPC_URL",
  IS_MAINNET ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org",
);

export const CONTRACT_ID = (() => {
  const id = env("CONTRACT_ID", "");
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
  "HORIZON_URL",
  IS_MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org",
);

/** stellar.expert and Stellar Lab disagree on the mainnet slug: `public` vs `mainnet`. */
const EXPERT_NETWORK = env("EXPERT_NETWORK", IS_MAINNET ? "public" : "testnet");
const LAB_NETWORK = env("LAB_NETWORK", IS_MAINNET ? "mainnet" : "testnet");

export const EXPERT_TX_BASE = env(
  "EXPERT_TX_BASE",
  `https://stellar.expert/explorer/${EXPERT_NETWORK}/tx`,
);

export function expertTxUrl(hash: string) {
  return `${EXPERT_TX_BASE}/${hash}`;
}

export function labContractUrl(id = CONTRACT_ID) {
  return `https://lab.stellar.org/r/${LAB_NETWORK}/contract/${id}`;
}
