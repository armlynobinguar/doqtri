const isProd = process.env.NODE_ENV === "production";

function required(name: string, fallback?: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  if (isProd || fallback === undefined) {
    throw new Error(
      `Missing ${name}. Set it in web/.env.local (see .env.example).`,
    );
  }
  return fallback;
}

/** Dev-only fallback — production requires NEXT_PUBLIC_CONTRACT_ID */
const DEV_CONTRACT =
  "CBWQV275C4MXYKRTFGAUD6FUJX2UHOE7D6LSKTTYYQ7ZBPM3KJSAQZWH";

export const RPC_URL = required(
  "NEXT_PUBLIC_SOROBAN_RPC_URL",
  "https://soroban-testnet.stellar.org",
);

export const CONTRACT_ID = required(
  "NEXT_PUBLIC_CONTRACT_ID",
  isProd ? undefined : DEV_CONTRACT,
);

export const NETWORK_PASSPHRASE = required(
  "NEXT_PUBLIC_NETWORK_PASSPHRASE",
  "Test SDF Network ; September 2015",
);

export const HORIZON_URL = required(
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
