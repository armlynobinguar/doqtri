import { Address, Asset, hash, Keypair, nativeToScVal, Networks, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { parseRelayBody, validateForwardedWrite } from "@/lib/stellar/relay-validation";
import { callsIn, draftFunc, FEE_APPROVAL_LEDGERS, forwardDraft, relayBody, walletEntryOf, type ForwardParams } from "./paid-write";

const contract = (seed: string) => StrKey.encodeContract(hash(Buffer.from(seed)));

const wallet = contract("wallet");
const registry = contract("registry");
const forwarder = contract("forwarder");
const relayer = Keypair.random().publicKey();
const xlm = Asset.native().contractId(Networks.TESTNET);
const maxFee = BigInt(5_000_000_000);
const docId = "0b7e0c8e-1d2f-4a51-9c0e-3f1d2a6b7c8d";

const registerCall = new xdr.InvokeContractArgs({
  contractAddress: Address.fromString(registry).toScAddress(),
  functionName: "register_document",
  args: [Address.fromString(wallet).toScVal(), xdr.ScVal.scvString(docId), xdr.ScVal.scvBytes(Buffer.alloc(32, 1))],
});

const params: ForwardParams = { call: registerCall, wallet, forwarder, relayer, xlm, maxFee, latestLedger: 4_000 };

const contractFn = (address: string, fn: string, args: xdr.ScVal[]) =>
  xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({ contractAddress: Address.fromString(address).toScAddress(), functionName: fn, args }),
  );

const invocation = (fn: xdr.SorobanAuthorizedFunction, subInvocations: xdr.SorobanAuthorizedInvocation[] = []) =>
  new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations });

/** The wallet's entry as simulating the forward draft discovers it: forward, then approve and the registry call. */
function simulatedWalletEntry(func: xdr.HostFunction, signer = wallet): xdr.SorobanAuthorizationEntry {
  const [feeToken, , max, expiration, target, fn, args] = func.invokeContract().args();
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer).toScAddress(),
        nonce: xdr.Int64.fromString("7"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation(contractFn(forwarder, "forward", [feeToken, max, expiration, target, fn, args]), [
      invocation(contractFn(xlm, "approve", [Address.fromString(wallet).toScVal(), Address.fromString(forwarder).toScVal(), max, expiration])),
      invocation(contractFn(registry, "register_document", registerCall.args())),
    ]),
  });
}

describe("forwardDraft", () => {
  it("builds the forward call the relay accepts for a paid register", () => {
    const func = draftFunc(forwardDraft(params, Networks.TESTNET));
    const write = validateForwardedWrite(
      { func, auth: [simulatedWalletEntry(func)] },
      { forwarder, xlm, registry, wallet, relayer, maxFeeCap: maxFee },
    );
    expect(write).toEqual({ fn: "register_document", docId, maxFee, expirationLedger: 4_000 + FEE_APPROVAL_LEDGERS });
  });

  it("leaves the fee to the relay and names the relayer last", () => {
    const args = draftFunc(forwardDraft(params, Networks.TESTNET)).invokeContract().args();
    expect(args).toHaveLength(9);
    expect(args[1].toXDR("base64")).toBe(nativeToScVal(BigInt(1), { type: "i128" }).toXDR("base64"));
    expect(Address.fromScVal(args[8]).toString()).toBe(relayer);
  });
});

describe("the wallet's entry", () => {
  const func = draftFunc(forwardDraft(params, Networks.TESTNET));

  it("is found among the simulation's entries and needs one rule id per call", () => {
    const entry = walletEntryOf([simulatedWalletEntry(func, contract("someone-else")), simulatedWalletEntry(func)], wallet)!;
    expect(Address.fromScAddress(entry.credentials().address().address()).toString()).toBe(wallet);
    expect(callsIn(entry.rootInvocation())).toBe(3);
  });

  it("is missing when the simulation asks nothing of the wallet", () => {
    expect(walletEntryOf([simulatedWalletEntry(func, contract("someone-else"))], wallet)).toBeUndefined();
  });

  it("travels in the body shape the relay parses", () => {
    const entry = simulatedWalletEntry(func);
    const parsed = parseRelayBody(relayBody(func, entry));
    expect(parsed.func.toXDR("base64")).toBe(func.toXDR("base64"));
    expect(parsed.auth.map((a) => a.toXDR("base64"))).toEqual([entry.toXDR("base64")]);
  });
});
