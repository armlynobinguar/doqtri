/**
 * Testnet only: fills a smart wallet with free test XLM (server-only,
 * progress/003).
 *
 * Friendbot only pays classic `G…` accounts, so a throwaway account is funded
 * first and then moves the XLM into the wallet through the native token
 * contract. That transfer is sourced and signed by the throwaway account and
 * sent straight to RPC: no passkey prompt, no relay, no Channels.
 */
import { Address, Contract, Keypair, nativeToScVal, rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { IS_MAINNET, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import { NATIVE_XLM } from "@/lib/stellar/smart-wallet-config";
import { RelayRejection } from "@/lib/stellar/relay-validation";

/** Friendbot pays 10,000 XLM; the throwaway account keeps a little for its reserve and the fee. */
const TRANSFER_XLM = BigInt(9_990);

export async function topUpWallet(wallet: string): Promise<{ hash: string; amountStroops: bigint }> {
  if (IS_MAINNET) throw new RelayRejection("Test XLM only exists on testnet.", 400);
  const temp = Keypair.random();
  const funded = await fetch(`https://friendbot.stellar.org/?addr=${temp.publicKey()}`);
  if (!funded.ok) {
    console.error(`[chain/topup] Friendbot refused (${funded.status})`);
    throw new RelayRejection("Friendbot is busy. Try again in a minute.", 503);
  }

  const server = new rpc.Server(RPC_URL);
  const amount = TRANSFER_XLM * BigInt(10_000_000);
  const source = await server.getAccount(temp.publicKey());
  const tx = new TransactionBuilder(source, { fee: "10000", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      new Contract(NATIVE_XLM).call(
        "transfer",
        Address.fromString(temp.publicKey()).toScVal(),
        Address.fromString(wallet).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ),
    )
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(temp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new RelayRejection("The top-up was rejected. Try again.", 502);
  const result = await server.pollTransaction(sent.hash, { attempts: 20 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new RelayRejection("The top-up failed on-chain. Try again.", 502);
  }
  return { hash: sent.hash, amountStroops: amount };
}
