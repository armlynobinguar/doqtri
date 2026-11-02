/**
 * The browser half of one paid write, without the browser (DOQ-2, WP-4.1).
 *
 * payAndRelay (lib/passkey-wallet.ts) wraps a registry call in the
 * FeeForwarder's `forward(...)`, simulates it to learn the wallet's auth
 * entry, has the passkey sign that entry, and posts `{ func, auth }` to the
 * relay. It is bound to the browser's kit, so the load test rebuilds the same
 * steps here; paid-write.test.ts holds the result to the relay's own
 * validateForwardedWrite, so a drift in either shows up as a failing test.
 */
import { Account, Address, Contract, nativeToScVal, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";

/** As payAndRelay: the fee approval stays valid ~1.5 hours. */
export const FEE_APPROVAL_LEDGERS = 1_000;
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export type ForwardParams = {
  /** The registry call to forward, as the bindings client built it. */
  call: xdr.InvokeContractArgs;
  wallet: string;
  forwarder: string;
  relayer: string;
  /** The native XLM token contract fees are paid in. */
  xlm: string;
  maxFee: bigint;
  /** The latest ledger when the write was prepared. */
  latestLedger: number;
};

/** `forward(...)` around `call`, argument for argument as payAndRelay builds it. */
export function forwardOperation(p: ForwardParams): xdr.Operation {
  return new Contract(p.forwarder).call(
    "forward",
    Address.fromString(p.xlm).toScVal(),
    nativeToScVal(BigInt(1), { type: "i128" }), // the relay sets the real fee
    nativeToScVal(p.maxFee, { type: "i128" }),
    nativeToScVal(p.latestLedger + FEE_APPROVAL_LEDGERS, { type: "u32" }),
    Address.fromScAddress(p.call.contractAddress()).toScVal(),
    xdr.ScVal.scvSymbol(p.call.functionName().toString()),
    xdr.ScVal.scvVec(p.call.args()),
    Address.fromString(p.wallet).toScVal(),
    Address.fromString(p.relayer).toScVal(),
  );
}

/** The sourceless draft payAndRelay simulates to discover the wallet's auth entry. */
export function forwardDraft(p: ForwardParams, networkPassphrase: string): Transaction {
  return new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: "100", networkPassphrase })
    .addOperation(forwardOperation(p))
    .setTimeout(60)
    .build();
}

/** The draft's host function: the `func` the relay receives. */
export function draftFunc(draft: Transaction): xdr.HostFunction {
  return (draft.operations[0] as unknown as { func: xdr.HostFunction }).func;
}

/** One context rule id per call the wallet authorizes: the root and every sub-call. */
export function callsIn(invocation: xdr.SorobanAuthorizedInvocation): number {
  return 1 + invocation.subInvocations().reduce((n, sub) => n + callsIn(sub), 0);
}

/** The simulation's auth entry that `wallet` must sign, if any. */
export function walletEntryOf(auth: xdr.SorobanAuthorizationEntry[], wallet: string): xdr.SorobanAuthorizationEntry | undefined {
  return auth.find(
    (entry) =>
      entry.credentials().switch().name === "sorobanCredentialsAddress" &&
      Address.fromScAddress(entry.credentials().address().address()).toString() === wallet,
  );
}

/** The relay request body, exactly as payAndRelay posts it. */
export function relayBody(func: xdr.HostFunction, signed: xdr.SorobanAuthorizationEntry): { func: string; auth: string[] } {
  return { func: func.toXDR("base64"), auth: [signed.toXDR("base64")] };
}
