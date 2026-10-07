/**
 * XLM held by a smart wallet (or any address), read from the native token
 * contract with a free simulation. Contract wallets have no Horizon account
 * page, so this is the way to read their balance (progress/003).
 */
import { Account, Address, Contract, rpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import { NATIVE_XLM } from "@/lib/stellar/smart-wallet-config";

const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Balance in stroops (1 XLM = 10,000,000). */
export async function xlmBalanceStroops(address: string): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(NATIVE_XLM).call("balance", Address.fromString(address).toScVal()))
    .setTimeout(30)
    .build();
  const simulation = await new rpc.Server(RPC_URL).simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error("Could not read the wallet balance.");
  }
  return BigInt(scValToNative(simulation.result.retval) as bigint | number);
}

export function formatXlm(stroops: bigint, digits = 2): string {
  return (Number(stroops) / 1e7).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
