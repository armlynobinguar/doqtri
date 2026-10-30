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
 * After either call the former owner holds no role on-chain, whatever the
 * database kept for them (D-35). formerOwnerFollowUp() says when the new
 * owner must follow with `add_admin`.
 *
 * WP-1.5 uses both: the members screen's transfer (acceptTransfer() in
 * lib/workspace-transfer.ts, behind /api/workspaces/[id]/transfer) builds
 * `transfer_workspace` here and, once it lands and the database has moved
 * the role, asks formerOwnerFollowUp() for the `add_admin` the new owner
 * then signs with DoqtriRegistry.addAdmin(); the D-31 handover job
 * (lib/stellar/chain-jobs.ts) builds `admin_reassign_owner` here.
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

/** The call that gives a former owner back on-chain the admin role the database kept for them. */
export type FormerOwnerFollowUp = { fn: "add_admin"; workspaceId: string; subject: string };

/**
 * After a transfer has landed on-chain: when the database keeps the former
 * owner (by the address that owned the workspace on-chain) as an admin, the
 * `add_admin` that makes the chain agree (D-35); else null, as the chain
 * already does: a former owner kept as an editor or viewer, or not kept,
 * has no admin role to restore, and one the database still lists as owner
 * means the database side of the transfer hasn't happened yet.
 *
 * `add_admin` is owner-only on-chain, so the new owner's wallet signs it and
 * /api/chain/relay submits it; the relay's own check (signer an owner in the
 * database, subject an admin there) is what this mirrors.
 */
export async function formerOwnerFollowUp(
  workspaceId: string,
  formerOwner: string,
  access: Pick<RegistryAccess, "workspace" | "addressRole">,
): Promise<FormerOwnerFollowUp | null> {
  const workspace = await access.workspace(workspaceId);
  // A personal workspace is never transferred (D-37), so there is nothing to follow.
  if (!workspace || workspace.personal) return null;
  const role = await access.addressRole(workspaceId, formerOwner);
  return role === "admin" ? { fn: "add_admin", workspaceId, subject: formerOwner } : null;
}
