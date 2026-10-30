import { describe, expect, it } from "vitest";
import { authorizeEntry, hash, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { transferInvocation, validateTransferApproval } from "@/lib/stellar/transfer-approval";

const registry = StrKey.encodeContract(hash(Buffer.from("registry")));
const ws = "7a000000-0000-4000-8000-0000000000c1";
const owner = Keypair.random();
const heir = Keypair.random();
const passphrase = "Test SDF Network ; September 2015";

function unsigned(signer: string, invocation: xdr.InvokeContractArgs, subs: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: xdr.ScAddress.scAddressTypeAccount(Keypair.fromPublicKey(signer).xdrAccountId()),
        nonce: xdr.Int64.fromString("7"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invocation),
      subInvocations: subs,
    }),
  });
}

async function signed(kp: Keypair, invocation: xdr.InvokeContractArgs) {
  return (await authorizeEntry(unsigned(kp.publicKey(), invocation), kp, 1_000, passphrase)).toXDR("base64");
}

describe("validateTransferApproval (D-29)", () => {
  const call = transferInvocation(registry, ws, owner.publicKey(), heir.publicKey());

  it("accepts each owner's signature over exactly the recorded transfer", async () => {
    const ownerEntry = validateTransferApproval(await signed(owner, call), call, owner.publicKey(), "owner");
    const heirEntry = validateTransferApproval(await signed(heir, call), call, heir.publicKey(), "new owner");
    expect(ownerEntry.credentials().address().signatureExpirationLedger()).toBe(1_000);
    expect(heirEntry.rootInvocation().function().contractFn().functionName().toString()).toBe("transfer_workspace");
  });

  it("refuses the other party's signature in place of the owner's", async () => {
    const heirXdr = await signed(heir, call);
    expect(() => validateTransferApproval(heirXdr, call, owner.publicKey(), "owner")).toThrow(/exactly this transfer/);
  });

  it("refuses an approval of a transfer to someone else, or of another workspace", async () => {
    const elsewhere = transferInvocation(registry, ws, owner.publicKey(), Keypair.random().publicKey());
    const other = transferInvocation(registry, "7a000000-0000-4000-8000-0000000000c2", owner.publicKey(), heir.publicKey());
    for (const wrong of [elsewhere, other]) {
      const entry = await signed(owner, wrong);
      expect(() => validateTransferApproval(entry, call, owner.publicKey(), "owner")).toThrow(/exactly this transfer/);
    }
  });

  it("refuses an approval that nests anything else", async () => {
    const nested = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    });
    const entry = (await authorizeEntry(unsigned(owner.publicKey(), call, [nested]), owner, 1_000, passphrase)).toXDR("base64");
    expect(() => validateTransferApproval(entry, call, owner.publicKey(), "owner")).toThrow(/exactly this transfer/);
  });

  it("refuses a missing or malformed approval", () => {
    expect(() => validateTransferApproval(undefined, call, owner.publicKey(), "owner")).toThrow(/missing/);
    expect(() => validateTransferApproval("not xdr", call, owner.publicKey(), "owner")).toThrow(/valid XDR/);
  });
});
