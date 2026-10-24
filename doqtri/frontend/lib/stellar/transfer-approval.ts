/**
 * The two signatures of an on-chain workspace transfer (D-29).
 *
 * `transfer_workspace(workspace_id, owner, new_owner)` needs both owners to
 * authorize it, and they do so at different times: the owner when proposing
 * the transfer, the new owner when accepting it. Each signs an auth entry
 * for exactly that call (with the owner's valid for days, so the new owner
 * has time to accept), the database keeps the owner's with the proposal,
 * and the accept route puts both into one transaction. A relay submission
 * carries one wallet's approval, which is why this never goes through
 * /api/chain/relay (relay-validation.ts).
 *
 * The route checks each entry here before paying to submit: that it is
 * signed for the address it claims and authorizes exactly the transfer the
 * database records, with nothing nested.
 */
import { Address, xdr } from "@stellar/stellar-sdk";
import { RelayRejection } from "@/lib/stellar/relay-validation";

/** How long the owner's signature waits for the new owner to accept, in ledgers (~7 days at 5s). */
export const OWNER_APPROVAL_LEDGERS = 120_960;
/** The new owner signs just before the route submits (~10 minutes). */
export const NEW_OWNER_APPROVAL_LEDGERS = 120;

/** The call both owners sign: `transfer_workspace(workspaceId, owner, newOwner)` on `registry`. */
export function transferInvocation(registry: string, workspaceId: string, owner: string, newOwner: string): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(registry).toScAddress(),
    functionName: "transfer_workspace",
    args: [xdr.ScVal.scvString(workspaceId), Address.fromString(owner).toScVal(), Address.fromString(newOwner).toScVal()],
  });
}

function signerOf(entry: xdr.SorobanAuthorizationEntry): string | null {
  const credentials = entry.credentials();
  switch (credentials.switch().name) {
    case "sorobanCredentialsAddress":
      return Address.fromScAddress(credentials.address().address()).toString();
    case "sorobanCredentialsAddressV2":
      return Address.fromScAddress(credentials.addressV2().address()).toString();
    default:
      return null;
  }
}

/**
 * Parses a base64 auth entry and checks that `signer` signed it for exactly
 * `invocation`. Throws RelayRejection otherwise.
 */
export function validateTransferApproval(
  entryXdr: unknown,
  invocation: xdr.InvokeContractArgs,
  signer: string,
  who: "owner" | "new owner",
): xdr.SorobanAuthorizationEntry {
  if (typeof entryXdr !== "string" || !entryXdr || entryXdr.length > 8192) {
    throw new RelayRejection(`The ${who}'s approval is missing.`, 400);
  }
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
  } catch {
    throw new RelayRejection(`The ${who}'s approval isn't valid XDR.`, 400);
  }
  const root = entry.rootInvocation();
  if (
    signerOf(entry) !== signer ||
    root.subInvocations().length !== 0 ||
    root.function().switch().name !== "sorobanAuthorizedFunctionTypeContractFn" ||
    !root.function().contractFn().toXDR().equals(invocation.toXDR())
  ) {
    throw new RelayRejection(`The ${who}'s approval doesn't cover exactly this transfer.`, 403);
  }
  return entry;
}
