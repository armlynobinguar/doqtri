/**
 * The chain project's mainnet refusal and its RPC budget (DOQ-19).
 *
 * Every spec in e2e/chain calls assertTestnet() in beforeAll, before anything
 * it does could write to a ledger. It reads the same settings the dev server
 * does (lib/stellar/config.ts, from the same .env files) and refuses unless:
 * - the network passphrase is testnet's;
 * - the RPC those settings name answers with testnet's passphrase;
 * - the registry and market contracts exist on that RPC.
 * A mainnet contract id cannot exist on testnet, so a misconfigured mix fails
 * here instead of signing anything.
 *
 * Secrets: this file reads none. The dev server uses DOQTRI_RELAYER_SECRET
 * (the relay that submits paid writes), CHANNELS_API_KEY (wallet deploys) and
 * REVOKER_SECRET_KEY (only for the on-chain removal step), from .env and
 * .env.chain. The specs never touch them.
 */
import { expect } from "@playwright/test";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { CONTRACT_ID, IS_MAINNET, MARKET_CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import { assertNotProduction } from "../guard";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/** How long one on-chain step may take before it counts as an RPC failure. */
export const CHAIN_STEP_TIMEOUT_MS = 120_000;

let checked: Promise<void> | null = null;

export function assertTestnet(): Promise<void> {
  checked ??= (async () => {
    assertNotProduction();
    if (IS_MAINNET || NETWORK_PASSPHRASE !== TESTNET_PASSPHRASE) {
      throw new Error(`Refusing to run: the network passphrase is "${NETWORK_PASSPHRASE}", not testnet's.`);
    }
    const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://localhost") });
    const network = await rpcCall("getNetwork", () => server.getNetwork());
    if (network.passphrase !== TESTNET_PASSPHRASE) {
      throw new Error(`Refusing to run: the RPC at ${new URL(RPC_URL).host} serves "${network.passphrase}", not testnet.`);
    }
    for (const [label, id] of [
      ["registry (NEXT_PUBLIC_CONTRACT_ID)", CONTRACT_ID],
      ["market (NEXT_PUBLIC_MARKET_CONTRACT_ID)", MARKET_CONTRACT_ID],
    ] as const) {
      if (!id) throw new Error(`Refusing to run: no ${label} is configured.`);
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(id).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
      const found = await rpcCall(`getLedgerEntries(${label})`, () => server.getLedgerEntries(key));
      if (found.entries.length === 0) {
        throw new Error(`Refusing to run: the ${label} ${id} does not exist on testnet.`);
      }
    }
  })();
  return checked;
}

/** Thrown when public RPC, Friendbot or Horizon, not the app, is what failed. */
export class RpcFailure extends Error {
  constructor(step: string, cause: unknown) {
    super(`RPC failure (not an app failure) during ${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RpcFailure";
  }
}

/** One call to public infrastructure, retried twice, reported as an RpcFailure if it never answers. */
export async function rpcCall<T>(step: string, call: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await call();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
    }
  }
  throw new RpcFailure(step, last);
}

/**
 * Waits for something the chain decides (a toast, a version tag), with the
 * step's bounded budget. On a timeout it says which step and that the wait
 * was on the ledger, so a slow testnet reads differently from a broken app.
 */
export async function untilConfirmed(step: string, check: () => Promise<void>, timeout = CHAIN_STEP_TIMEOUT_MS): Promise<void> {
  try {
    await expect(check).toPass({ timeout, intervals: [1_000, 2_000, 5_000] });
  } catch (error) {
    throw new Error(
      `"${step}" was not confirmed within ${Math.round(timeout / 1000)} s. If the app showed no error, testnet RPC was slow or down: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
