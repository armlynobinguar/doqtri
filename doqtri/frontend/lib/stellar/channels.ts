/**
 * OpenZeppelin Stellar Channels: fee-sponsored submission (server-only).
 *
 * Channels builds the transaction around `{ func, auth }` from its own pool
 * of channel accounts and pays the fee, within a per-API-key daily fee cap
 * (FEE_LIMIT_EXCEEDED once spent). The key is server-only: anyone holding it
 * could spend that allowance.
 */
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { rpc, TransactionBuilder, Account, Operation, type xdr } from "@stellar/stellar-sdk";
import { IS_MAINNET, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import { RelayRejection } from "@/lib/stellar/relay-validation";

const BASE_URL = IS_MAINNET
  ? "https://channels.openzeppelin.com"
  : "https://channels.openzeppelin.com/testnet";

/** An all-zero account: simulation needs a source, not an existing one. */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Refuse anything whose simulated resource fee is above this. Mainnet wallet
 * deploys simulate at ~0.29 XLM and registry writes at ~0.07 XLM; occasional
 * first-touch TTL bumps cost far more and are deliberately refused.
 */
function maxResourceFeeStroops(): bigint {
  const raw = process.env.CHAIN_MAX_RESOURCE_FEE_STROOPS;
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : BigInt(5_000_000);
}

export function channelsClient(): ChannelsClient {
  const apiKey = process.env.CHANNELS_API_KEY?.trim();
  if (!apiKey) throw new RelayRejection("On-chain relay is not configured", 503);
  return new ChannelsClient({ baseUrl: BASE_URL, apiKey });
}

/** Simulates without spending anything; rejects failures and fees over the cap. */
export async function simulateWithinCap(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
): Promise<void> {
  const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(30)
    .build();
  const simulation = await new rpc.Server(RPC_URL).simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation) || rpc.Api.isSimulationRestore(simulation)) {
    throw new RelayRejection("The transaction would fail on-chain", 422);
  }
  if (BigInt(simulation.minResourceFee) > maxResourceFeeStroops()) {
    throw new RelayRejection(
      "This transaction is unusually expensive right now. Try again later.",
      413,
    );
  }
}

/** Submits through Channels and waits for the ledger's verdict. */
export async function submitAndConfirm(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
): Promise<{ transactionId: string; hash: string; status: string }> {
  let sent;
  try {
    sent = await channelsClient().submitSorobanTransaction({
      func: func.toXDR("base64"),
      auth: auth.map((entry) => entry.toXDR("base64")),
    });
  } catch (error) {
    if (error instanceof RelayRejection) throw error;
    const detail = JSON.stringify((error as { errorDetails?: unknown }).errorDetails ?? "");
    console.error(`[chain/relay] Channels refused: ${(error as Error).message} ${detail.slice(0, 500)}`);
    if (detail.includes("FEE_LIMIT_EXCEEDED")) {
      throw new RelayRejection("Doqtri's on-chain allowance for today is used up. Try again tomorrow.", 503);
    }
    if (detail.includes("POOL_CAPACITY")) {
      throw new RelayRejection("The network relay is busy. Try again in a moment.", 503);
    }
    throw new RelayRejection("The network relay could not submit this transaction.", 502);
  }

  if (!sent.hash) {
    console.error(`[chain/relay] Channels returned no hash for ${sent.transactionId}`);
    throw new RelayRejection("The network relay did not return a transaction.", 502);
  }
  const result = await new rpc.Server(RPC_URL).pollTransaction(sent.hash, { attempts: 20 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    console.error(`[chain/relay] ${sent.hash} ended ${result.status}`);
    throw new RelayRejection("The transaction failed on-chain.", 502);
  }
  return { transactionId: sent.transactionId ?? "", hash: sent.hash, status: sent.status ?? "confirmed" };
}
