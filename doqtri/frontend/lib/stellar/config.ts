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
  MARKET_CONTRACT_ID: process.env.NEXT_PUBLIC_MARKET_CONTRACT_ID,
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

/**
 * Public testnet DoqtriRegistry (v2: one-call `anchor`, upgradeable) —
 * override via NEXT_PUBLIC_* in .env.local / Vercel.
 */
const TESTNET_CONTRACT =
  "CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ";

/**
 * Registries this one took its documents from (scripts/migrate-registry.mjs).
 * Their writes are still part of a migrated document's history, which is
 * read from the ledger, so history looks at these contracts too.
 */
const TESTNET_LEGACY_CONTRACTS = ["CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB"];

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
  // A dashboard value still naming a registry this app migrated away from is
  // stale, not a choice: its documents were copied to TESTNET_CONTRACT, and
  // writes the current code makes (anchor) don't exist on it.
  if (id && !TESTNET_LEGACY_CONTRACTS.includes(id)) return id;
  if (IS_MAINNET) {
    throw new Error(
      "NEXT_PUBLIC_CONTRACT_ID is required when NEXT_PUBLIC_NETWORK_PASSPHRASE is mainnet — " +
        "refusing to fall back to the testnet contract.",
    );
  }
  return TESTNET_CONTRACT;
})();

/** Earlier registries whose writes still count toward a document's history. */
export const LEGACY_CONTRACT_IDS: readonly string[] =
  CONTRACT_ID === TESTNET_CONTRACT ? TESTNET_LEGACY_CONTRACTS : [];

/** Public testnet TemplateMarket (progress/004). */
const TESTNET_MARKET_CONTRACT = "CA6YPRXQ2IFGACBFLKWEFETGLZ2C5R7DG5TTBKTTP4AVYOF3HFOSBCC2";

/**
 * The template marketplace contract, or null where it isn't deployed. Like
 * CONTRACT_ID it never falls back to the testnet contract on mainnet; unlike
 * it, a missing id switches the marketplace off instead of failing the app.
 */
export const MARKET_CONTRACT_ID: string | null = env("MARKET_CONTRACT_ID", "") || (IS_MAINNET ? null : TESTNET_MARKET_CONTRACT);

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

/** Contract pages live next to tx pages: `.../explorer/<network>/contract/<id>`. */
export function expertContractUrl(id: string) {
  return `${EXPERT_TX_BASE.replace(/\/tx$/, "")}/contract/${id}`;
}

/** stellar.expert's public API summary of a contract, including its invocation count. */
export function expertApiContractUrl(id: string) {
  return `https://api.stellar.expert/explorer/${EXPERT_NETWORK}/contract/${id}`;
}

/** Classic (`G…`) account pages: `.../explorer/<network>/account/<id>`. */
export function expertAccountUrl(id: string) {
  return `${EXPERT_TX_BASE.replace(/\/tx$/, "")}/account/${id}`;
}

/** The right stellar.expert page for any address: contract (`C…`) or account (`G…`). */
export function expertAddressUrl(id: string) {
  return id.startsWith("C") ? expertContractUrl(id) : expertAccountUrl(id);
}

export function labContractUrl(id = CONTRACT_ID) {
  return `https://lab.stellar.org/r/${LAB_NETWORK}/contract/${id}`;
}
