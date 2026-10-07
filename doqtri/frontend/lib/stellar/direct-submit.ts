/**
 * Submits forwarded (user-paid) writes as Doqtri's relayer account, straight
 * to Stellar RPC — no Channels (server-only, progress/003).
 *
 * The relayer is the transaction source and pays the network fee; inside the
 * same transaction the FeeForwarder moves `fee_amount` XLM from the user's
 * wallet to the relayer. `fee_amount` is set here, from a simulation that
 * already includes the wallet's passkey signature (verifying it costs extra),
 * and is never above the maximum the user signed.
 */
import {
  authorizeEntry,
  Horizon,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { HORIZON_URL, IS_MAINNET, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import { RelayRejection } from "@/lib/stellar/relay-validation";

/** Inclusion fee bid per transaction, in stroops (0.0001 XLM). */
const INCLUSION_FEE = 1_000;
/** On testnet, refill the relayer from Friendbot below this balance. */
const TESTNET_REFILL_BELOW_XLM = 1_000;
/** How long the relayer's own approval stays valid, in ledgers (~10 minutes). */
const RELAYER_AUTH_LEDGERS = 100;

export function relayerKeypair(): Keypair {
  const secret = process.env.DOQTRI_RELAYER_SECRET?.trim();
  if (!secret) throw new RelayRejection("Paid writes are not configured", 503);
  return Keypair.fromSecret(secret);
}

/** `func` with the forwarder's `fee_amount` (argument 1) replaced. */
function withFee(func: xdr.HostFunction, fee: bigint): xdr.HostFunction {
  const invoke = func.invokeContract();
  const args = [...invoke.args()];
  args[1] = nativeToScVal(fee, { type: "i128" });
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: invoke.contractAddress(),
      functionName: invoke.functionName(),
      args,
    }),
  );
}

/** The relayer's own approval of exactly this `forward` call (it has no sub-calls). */
async function relayerAuth(func: xdr.HostFunction, kp: Keypair, latestLedger: number) {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: xdr.ScAddress.scAddressTypeAccount(kp.xdrAccountId()),
        nonce: xdr.Int64.fromString(String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(func.invokeContract()),
      subInvocations: [],
    }),
  });
  return authorizeEntry(entry, kp, latestLedger + RELAYER_AUTH_LEDGERS, NETWORK_PASSPHRASE);
}

async function ensureRelayerFunded(publicKey: string): Promise<void> {
  if (IS_MAINNET) return;
  try {
    const account = await new Horizon.Server(HORIZON_URL).loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === "native");
    if (native && Number(native.balance) >= TESTNET_REFILL_BELOW_XLM) return;
  } catch {
    // Not created yet: Friendbot creates it.
  }
  await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`).catch(() => undefined);
}

export type PaidWriteResult = { hash: string; feeStroops: bigint };

/**
 * Prices, signs and submits one forwarded write. `walletEntry` is the wallet's
 * passkey-signed approval; `maxFee` is what the user signed as the most they
 * will pay.
 */
export async function submitPaidWrite(
  func: xdr.HostFunction,
  walletEntry: xdr.SorobanAuthorizationEntry,
  maxFee: bigint,
): Promise<PaidWriteResult> {
  const kp = relayerKeypair();
  const server = new rpc.Server(RPC_URL);
  await ensureRelayerFunded(kp.publicKey());

  const build = async (fee: bigint) => {
    const { sequence } = await server.getLatestLedger();
    const priced = withFee(func, fee);
    const auth = [walletEntry, await relayerAuth(priced, kp, sequence)];
    const source = await server.getAccount(kp.publicKey());
    const tx = new TransactionBuilder(source, { fee: String(INCLUSION_FEE), networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.invokeHostFunction({ func: priced, auth }))
      .setTimeout(60)
      .build();
    const simulation = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(simulation) || rpc.Api.isSimulationRestore(simulation)) {
      const detail = rpc.Api.isSimulationError(simulation) ? simulation.error : "needs a restore";
      console.error(`[chain/relay] paid write simulation failed: ${String(detail).slice(0, 300)}`);
      if (/balance|insufficient|#10\b/i.test(String(detail))) {
        throw new RelayRejection("Your wallet doesn't have enough XLM for this. Top it up and try again.", 402);
      }
      throw new RelayRejection("The transaction would fail on-chain", 422);
    }
    return { tx, simulation };
  };

  // 1. Measure with a token fee: the signatures are in place, so the resource
  //    fee includes verifying the passkey.
  const measured = await build(BigInt(1));
  const fee = BigInt(measured.simulation.minResourceFee) + BigInt(INCLUSION_FEE);
  if (fee > maxFee) {
    throw new RelayRejection("This write costs more than the most you approved. Try again.", 409);
  }

  // 2. Charge exactly that, then submit. A stale sequence number means another
  //    write went out from the relayer in between: rebuild and retry.
  for (let attempt = 1; ; attempt++) {
    const { tx, simulation } = await build(fee);
    const prepared = rpc.assembleTransaction(tx, simulation).build();
    prepared.sign(kp);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      const code = sent.errorResult?.result().switch().name ?? sent.status;
      if (attempt < 3 && (code === "txBadSeq" || sent.status === "TRY_AGAIN_LATER")) continue;
      console.error(`[chain/relay] paid write rejected: ${code}`);
      throw new RelayRejection("The network rejected this transaction. Try again.", 502);
    }
    const result = await server.pollTransaction(sent.hash, { attempts: 20 });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      console.error(`[chain/relay] paid write ${sent.hash} ended ${result.status}`);
      throw new RelayRejection("The transaction failed on-chain.", 502);
    }
    return { hash: sent.hash, feeStroops: fee };
  }
}
