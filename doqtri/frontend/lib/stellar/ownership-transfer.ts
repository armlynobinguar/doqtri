/**
 * Handing a workspace to a new owner on-chain (server-only).
 *
 * Two registry calls move a workspace, and with it every note assigned to
 * it (D-29): `transfer_workspace`, which the outgoing and incoming owners
 * both sign, and `admin_reassign_owner`, which only the contract admin signs
 * (D-36), for recovery and for D-31's promotion when the last owner deletes
 * their account. Neither goes through /api/chain/relay's registry checks: a
 * relay submission carries one wallet's approval, and the contract admin's
 * key never reaches the browser. The server builds them here instead.
 *
 * The contract does not know which workspaces are personal, so D-30 (only a
 * personal workspace's creator owns it) is the app's to hold: this builder
 * refuses a personal workspace outright (D-37).
 *
 * TODO(WP-1.5): nothing transfers a workspace yet: there is no transfer
 * screen and no database function that moves the owner role. Whatever adds
 * them must build the on-chain call with buildOwnershipTransfer(), never by
 * hand, so a personal workspace is never handed on.
 */
import { Address, xdr } from "@stellar/stellar-sdk";
import { RelayRejection, type RegistryAccess } from "@/lib/stellar/relay-validation";

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type OwnershipTransfer =
  /** The owner gives the workspace away; `owner` and `newOwner` both sign. */
  | { fn: "transfer_workspace"; workspaceId: string; owner: string; newOwner: string }
  /** Recovery by the contract admin (D-36); `newOwner` does not sign. */
  | { fn: "admin_reassign_owner"; workspaceId: string; newOwner: string };

function address(value: string, what: string): xdr.ScVal {
  try {
    return Address.fromString(value).toScVal();
  } catch {
    throw new RelayRejection(`The ${what} is not a Stellar address.`, 400);
  }
}

/**
 * The host function for `transfer`, on `registry`, for the server to sign
 * and submit. Refuses a personal workspace (D-30, D-37), a workspace doqtri
 * does not know, and anything that is not an app workspace id or an address.
 */
export async function buildOwnershipTransfer(
  transfer: OwnershipTransfer,
  access: Pick<RegistryAccess, "workspace">,
  registry: string,
): Promise<xdr.HostFunction> {
  if (!WORKSPACE_ID.test(transfer.workspaceId)) {
    throw new RelayRejection("That isn't a workspace id.", 400);
  }
  const workspace = await access.workspace(transfer.workspaceId);
  if (!workspace) throw new RelayRejection("There is no such workspace.", 404);
  if (workspace.personal) {
    throw new RelayRejection("A personal workspace stays with the person who created it; it can't be handed on.");
  }
  const id = xdr.ScVal.scvString(transfer.workspaceId);
  const args =
    transfer.fn === "transfer_workspace"
      ? [id, address(transfer.owner, "current owner"), address(transfer.newOwner, "new owner")]
      : [id, address(transfer.newOwner, "new owner")];
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(registry).toScAddress(),
      functionName: transfer.fn,
      args,
    }),
  );
}
