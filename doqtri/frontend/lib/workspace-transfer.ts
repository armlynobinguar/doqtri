/**
 * Accepting a workspace transfer (server-only, D-29, D-35, D-37).
 *
 * The owner proposed it from the members screen, with their wallet's signed
 * approval of `transfer_workspace` when the workspace is on-chain. The new
 * owner accepts here, with theirs. The chain moves first and the database
 * after (D-04: the database never names an owner the chain does not), and
 * the route then tells the new owner to sign `add_admin` for the former
 * owner, whom the database keeps as an admin but the chain leaves with no
 * role (D-35).
 *
 * With REGISTRY_EDITORS off, or a workspace that is not on-chain yet, only
 * the database changes. A personal workspace is never transferred: the
 * database refuses to propose one, and buildOwnershipTransfer() refuses to
 * build one (D-30, D-37).
 */
import type { xdr } from "@stellar/stellar-sdk";
import { buildOwnershipTransfer, formerOwnerFollowUp, type FormerOwnerFollowUp } from "@/lib/stellar/ownership-transfer";
import { RelayRejection, type RegistryAccess } from "@/lib/stellar/relay-validation";
import { transferInvocation, validateTransferApproval } from "@/lib/stellar/transfer-approval";

/** The open transfer, as workspace_transfers holds it. */
export type OpenTransfer = {
  workspace_id: string;
  from_user: string;
  to_user: string;
  owner_address: string | null;
  new_owner_address: string | null;
  owner_approval: string | null;
};

export type TransferDeps = {
  editors: boolean;
  registry: string;
  access: Pick<RegistryAccess, "workspace" | "addressRole">;
  /** The workspace's on-chain owner, or null when it is not on-chain. */
  readChainOwner(workspaceId: string): Promise<string | null>;
  /** The wallet the user signs with on this network, or null. */
  addressOf(userId: string): Promise<string | null>;
  /** Simulates, submits and waits for the ledger; returns the hash. */
  submit(func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[]): Promise<string>;
  /** accept_workspace_transfer(): the database side. Returns the former owner's id. */
  acceptInDatabase(workspaceId: string, userId: string): Promise<string>;
};

export type AcceptResult = {
  /** The on-chain transfer, when this request sent it. */
  txHash: string | null;
  /** What the new owner should sign next (D-35), if anything. */
  followUp: FormerOwnerFollowUp | null;
};

/**
 * Carries out `transfer` for `userId`, who must be its new owner. Throws
 * RelayRejection with a message for the person when it cannot.
 */
export async function acceptTransfer(
  transfer: OpenTransfer | null,
  userId: string,
  newOwnerApproval: unknown,
  deps: TransferDeps,
): Promise<AcceptResult> {
  if (!transfer || transfer.to_user !== userId) {
    throw new RelayRejection("There is no open transfer of this workspace to you.", 404);
  }
  const workspaceId = transfer.workspace_id;
  let txHash: string | null = null;
  let onChain = false;

  if (deps.editors) {
    const chainOwner = await deps.readChainOwner(workspaceId);
    if (chainOwner !== null) {
      onChain = true;
      const { owner_address: owner, new_owner_address: newOwner, owner_approval: ownerApproval } = transfer;
      if (!owner || !newOwner || !ownerApproval) {
        throw new RelayRejection(
          "This workspace is on-chain, so the owner's wallet has to sign the transfer. Ask them to propose it again.",
          409,
        );
      }
      const mine = await deps.addressOf(userId);
      if (mine !== newOwner) {
        throw new RelayRejection("The transfer names a different wallet than yours. Ask the owner to propose it again.", 409);
      }
      if (chainOwner !== newOwner) {
        if (chainOwner !== owner) {
          throw new RelayRejection("The workspace changed hands on-chain since this was proposed. Ask the owner to propose it again.", 409);
        }
        // Personal workspaces are refused here too (D-37).
        const func = await buildOwnershipTransfer({ fn: "transfer_workspace", workspaceId, owner, newOwner }, deps.access, deps.registry);
        const invocation = transferInvocation(deps.registry, workspaceId, owner, newOwner);
        const auth = [
          validateTransferApproval(ownerApproval, invocation, owner, "owner"),
          validateTransferApproval(newOwnerApproval, invocation, newOwner, "new owner"),
        ];
        txHash = await deps.submit(func, auth);
      }
      // Already the new owner on-chain (an earlier accept landed there and
      // the database step failed): carry on with the database.
    }
  }

  await deps.acceptInDatabase(workspaceId, userId);
  const followUp =
    onChain && transfer.owner_address ? await formerOwnerFollowUp(workspaceId, transfer.owner_address, deps.access) : null;
  return { txHash, followUp };
}
