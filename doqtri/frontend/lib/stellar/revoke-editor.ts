/**
 * The revoke-only server key (server-only, D-16).
 *
 * A member removed or demoted in the app loses their rights in the database
 * at once, and the relay refuses their writes from that moment (WP-1.4). The
 * chain follows here: the registry's revoker, one contract-wide key the
 * contract admin sets with `set_revoker`, may remove editors and admins from
 * any workspace and do nothing else, so a removal never waits for an admin's
 * wallet. Its secret is REVOKER_SECRET_KEY, which never leaves the server.
 *
 * Each revocation brings one wallet's on-chain role down to what the
 * database allows *now* (workspace-chain.ts), read again before every call:
 *
 *   on-chain admin,  database editor       remove_admin (an admin re-adds them as editor)
 *   on-chain admin,  database viewer/none  remove_admin
 *   on-chain editor, database viewer/none  remove_editor
 *   anything else                           nothing to do
 *
 * so it is idempotent (the registry's removals also return false rather than
 * fail when the member is already gone) and never takes away a role the
 * database has since given back. It retries until a ledger confirms the
 * chain agrees; a job still unconfirmed after its attempts stays pending in
 * workspace_chain_jobs and the next run picks it up (chain-jobs.ts).
 */
import type { Keypair } from "@stellar/stellar-sdk";
import {
  ChainCallRefused,
  membershipArgs,
  readChainWorkspace,
  serverKeypair,
  submitRegistryCall,
} from "@/lib/stellar/server-signer";
import { chainRoleOf, revocationCall, type ChainRole } from "@/lib/stellar/workspace-chain";

/** What the revoker reads and writes on-chain; the registry in production, fixtures in tests. */
export type RevokerChain = {
  /** `address`'s role in the workspace, or "no_workspace" when the workspace is not on-chain. */
  readRole(workspaceId: string, address: string): Promise<ChainRole | "no_workspace">;
  /** Sends one removal, signed by the revoker; resolves with its hash once a ledger includes it. */
  submit(fn: "remove_admin" | "remove_editor", workspaceId: string, address: string): Promise<string>;
};

export type RevocationTarget = {
  workspaceId: string;
  address: string;
  /** The most the chain may keep for this wallet: allowedChainRole() of its database role now. */
  allowed: ChainRole;
};

export type RevocationOutcome =
  /** The chain grants no more than the database. `txHash` is the last removal sent, if any. */
  | { status: "done"; txHash: string | null; calls: ("remove_admin" | "remove_editor")[] }
  /** Retrying will not help: the wallet is the workspace's on-chain owner, or the contract refused for good. */
  | { status: "failed"; error: string }
  /** Not confirmed yet; try again later. */
  | { status: "retry"; error: string };

export type RevokeOptions = {
  /** Failed reads or sends allowed before giving up for now. */
  attempts?: number;
  /** First wait between failures; doubles each time. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Codes that are about this deployment, not this call: the registry has no
 * such revoker yet (#8 NotWorkspaceOwner from remove_admin, #9
 * NotWorkspaceAdmin from remove_editor, until the contract admin runs
 * `set_revoker` with this key). Kept pending so they go through once it is
 * set. #12 TargetIsAdmin means the role changed between read and send.
 */
const RETRYABLE_CODES = new Set([8, 9, 12]);

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * Brings `target.address` down to `target.allowed` in its workspace, reading
 * the chain before each call and after it to confirm. At most two removals
 * are ever needed, so the loop is bounded by the attempts plus those.
 */
export async function revokeOnChain(
  target: RevocationTarget,
  chain: RevokerChain,
  { attempts = 3, delayMs = 2_000, sleep = wait }: RevokeOptions = {},
): Promise<RevocationOutcome> {
  const calls: ("remove_admin" | "remove_editor")[] = [];
  let txHash: string | null = null;
  let failures = 0;
  let lastError = "";

  for (let step = 0; step < attempts + 3; step++) {
    let current: ChainRole | "no_workspace";
    try {
      current = await chain.readRole(target.workspaceId, target.address);
    } catch (error) {
      lastError = `Reading the workspace on-chain failed: ${describe(error)}`;
      if (++failures >= attempts) break;
      await sleep(delayMs * 2 ** (failures - 1));
      continue;
    }
    if (current === "no_workspace") return { status: "done", txHash, calls };

    const call = revocationCall(current, target.allowed);
    if (call === null) return { status: "done", txHash, calls };
    if (call === "owner") {
      return {
        status: "failed",
        error: "This wallet owns the workspace on-chain; only a transfer or the contract admin can change that.",
      };
    }

    try {
      txHash = await chain.submit(call, target.workspaceId, target.address);
      calls.push(call);
    } catch (error) {
      lastError = describe(error);
      if (error instanceof ChainCallRefused && error.code !== null && !RETRYABLE_CODES.has(error.code)) {
        return { status: "failed", error: lastError };
      }
      if (++failures >= attempts) break;
      await sleep(delayMs * 2 ** (failures - 1));
    }
  }
  return { status: "retry", error: lastError || "The chain still shows a role the database has removed." };
}

/** The registry, signed by `revoker`. */
export function registryRevokerChain(revoker: Keypair): RevokerChain {
  return {
    async readRole(workspaceId, address) {
      const workspace = await readChainWorkspace(workspaceId);
      return workspace ? chainRoleOf(workspace, address) : "no_workspace";
    },
    submit(fn, workspaceId, address) {
      return submitRegistryCall(revoker, fn, membershipArgs(workspaceId, revoker.publicKey(), address));
    },
  };
}

/** The revoker from REVOKER_SECRET_KEY, or null when this deployment has none. */
export function configuredRevoker(): RevokerChain | null {
  const kp = serverKeypair("REVOKER_SECRET_KEY");
  return kp ? registryRevokerChain(kp) : null;
}
