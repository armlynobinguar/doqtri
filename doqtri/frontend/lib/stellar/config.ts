function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** Public testnet DoqtriRegistry — override via NEXT_PUBLIC_* in .env.local / Vercel */
const TESTNET_CONTRACT =
  "CCB5DFZRFFDCIBV5H5KWO6UCVN4ZXIPUSXONMBA6HVF433SPO7YEWMSB";

export const RPC_URL = env(
  "NEXT_PUBLIC_SOROBAN_RPC_URL",
  "https://soroban-testnet.stellar.org",
);

export const CONTRACT_ID = env("NEXT_PUBLIC_CONTRACT_ID", TESTNET_CONTRACT);

export const NETWORK_PASSPHRASE = env(
  "NEXT_PUBLIC_NETWORK_PASSPHRASE",
  "Test SDF Network ; September 2015",
);

export const HORIZON_URL = env(
  "NEXT_PUBLIC_HORIZON_URL",
  "https://horizon-testnet.stellar.org",
);

export const EXPERT_TX_BASE =
  process.env.NEXT_PUBLIC_EXPERT_TX_BASE ??
  "https://stellar.expert/explorer/testnet/tx";

export function expertTxUrl(hash: string) {
  return `${EXPERT_TX_BASE}/${hash}`;
}

export function labContractUrl(id = CONTRACT_ID) {
  return `https://lab.stellar.org/r/testnet/contract/${id}`;
}
