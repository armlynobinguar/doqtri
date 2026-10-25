/**
 * Template marketplace (progress/004): which tokens a listing can be priced
 * in, and the fee ceiling for market writes.
 *
 * The contract keeps its own admin-managed token allowlist; this list is what
 * the app offers and what the relay accepts. Both must agree, or listings in a
 * token the contract refuses would fail at signing.
 */
import { Asset } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import { MAX_USER_FEE_STROOPS, NETWORK } from "@/lib/stellar/smart-wallet-config";

export type MarketTokenCode = "XLM" | "USDC";

export type MarketToken = {
  code: MarketTokenCode;
  /** Stellar Asset Contract id on this network. */
  contract: string;
  /** Classic asset, for trustline checks on G... accounts (null for XLM). */
  asset: { code: string; issuer: string } | null;
  /** Smallest paid price, in the token's smallest unit. Dust listings are refused. */
  minPrice: bigint;
};

/** Circle's USDC issuers. */
const USDC_ISSUER = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
} as const;

/** Both tokens use 7 decimals. */
export const TOKEN_DECIMALS = 7;
const UNIT = BigInt(10) ** BigInt(TOKEN_DECIMALS);

export const MARKET_TOKENS: readonly MarketToken[] = [
  {
    code: "XLM",
    contract: Asset.native().contractId(NETWORK_PASSPHRASE),
    asset: null,
    minPrice: UNIT, // 1 XLM
  },
  {
    code: "USDC",
    contract: new Asset("USDC", USDC_ISSUER[NETWORK]).contractId(NETWORK_PASSPHRASE),
    asset: { code: "USDC", issuer: USDC_ISSUER[NETWORK] },
    minPrice: UNIT / BigInt(2), // 0.50 USDC
  },
];

export function marketToken(contract: string): MarketToken | null {
  return MARKET_TOKENS.find((t) => t.contract === contract) ?? null;
}

export function marketTokenByCode(code: string): MarketToken | null {
  return MARKET_TOKENS.find((t) => t.code === code) ?? null;
}

/**
 * The most a passkey user signs to pay for one market write. Users are charged
 * the actual cost, never more than this.
 *
 * 1 XLM where registry writes are capped at 0.5: a listing creates a ~500-byte
 * persistent entry and measured 0.47–0.54 XLM on testnet (2026-10-13). Where
 * the registry cap is raised for testnet rent (see MAX_USER_FEE_STROOPS), the
 * same cap applies here.
 */
export const MAX_MARKET_FEE_STROOPS =
  MAX_USER_FEE_STROOPS > BigInt(10_000_000) ? MAX_USER_FEE_STROOPS : BigInt(10_000_000);

/** Paid templates (phase 2). One switch for the publish form, the API and the gallery. */
export const PAID_TEMPLATES_ENABLED = true;
