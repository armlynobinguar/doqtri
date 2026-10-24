/**
 * Works through workspace_chain_jobs (server-only, WP-1.5): the on-chain
 * follow-ups the database queues for itself.
 *
 *   revoke          a member lost an editor or admin role; the revoker
 *                   (revoke-editor.ts) brings their wallet down to match
 *   reassign_owner  an account deletion handed a team workspace to its
 *                   longest-standing admin (D-31); the contract admin moves
 *                   the on-chain owner with `admin_reassign_owner` (D-36)
 *
 * Runs after every change on the members screen, when the screen loads, and
 * from /api/chain/jobs on a schedule, so a job whose call failed is retried
 * until a ledger confirms it. With REGISTRY_EDITORS off the registry has no
 * workspace calls at all: nothing is claimed and nothing is sent, and the
 * queue simply waits.
 *
 * Without REVOKER_SECRET_KEY revocations stay pending (the screen shows them
 * as pending on-chain). Without CONTRACT_ADMIN_SECRET a handover is marked
 * as needing the product owner, and logged, because only they hold that key.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { xdr } from "@stellar/stellar-sdk";
import { CONTRACT_ID, REGISTRY_EDITORS } from "@/lib/stellar/config";
import { buildOwnershipTransfer } from "@/lib/stellar/ownership-transfer";
import { registryAccess } from "@/lib/stellar/registry-access";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import type { RegistryAccess } from "@/lib/stellar/relay-validation";
import { configuredRevoker, revokeOnChain, type RevokeOptions, type RevokerChain } from "@/lib/stellar/revoke-editor";
import { readChainWorkspace, serverKeypair, submitRegistryCall } from "@/lib/stellar/server-signer";
import { allowedChainRole } from "@/lib/stellar/workspace-chain";
import type { WorkspaceRole } from "@/lib/workspace-roles";

export type ChainJob = {
  id: string;
  workspace_id: string;
  kind: "revoke" | "reassign_owner";
  user_id: string | null;
  address: string | null;
  network: string | null;
  attempts: number;
};

export type JobUpdate = {
  status: "pending" | "done" | "needs_product_owner" | "failed";
  tx_hash?: string | null;
  last_error?: string | null;
  /** When a pending job may be tried again. */
  next_attempt_at?: string;
};

/** The database side of the queue; Supabase in production, an in-memory store in tests. */
export type ChainJobStore = {
  claim(workspaceId: string | null, limit: number): Promise<ChainJob[]>;
  finish(id: string, update: JobUpdate): Promise<void>;
  /** Puts jobs waiting for the product owner back in the queue, once their key is configured. */
  reopenProductOwnerJobs(): Promise<void>;
  /** The database role, now, of the account holding `address` in the workspace. */
  roleOfAddress(workspaceId: string, address: string): Promise<WorkspaceRole | null>;
  /** The wallet `userId` signs with on this network, or null. */
  addressOf(userId: string): Promise<string | null>;
};

/** Moves a workspace's on-chain owner as the contract admin (D-36). */
export type OwnerReassigner = {
  /** The workspace's on-chain owner, or null when it is not on-chain. */
  readOwner(workspaceId: string): Promise<string | null>;
  reassign(workspaceId: string, newOwner: string): Promise<string>;
};

export type ProcessDeps = {
  /** REGISTRY_EDITORS: the deployed registry has the workspace calls. */
  editors: boolean;
  network: string;
  revoker: RevokerChain | null;
  reassigner: OwnerReassigner | null;
  now?: () => Date;
  revokeOptions?: RevokeOptions;
};

export type ProcessSummary = { skipped: boolean; done: number; pending: number; failed: number; needsProductOwner: number };

/** Waits 30s, 1m, 2m, … up to an hour between tries of a job that keeps failing. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

function later(now: Date, ms: number): string {
  return new Date(now.getTime() + ms).toISOString();
}

/**
 * Claims the jobs that are due (of one workspace, or all) and carries each
 * as far as it goes. Never throws for a single job: its outcome is written
 * back and the next one runs.
 */
export async function processChainJobs(
  store: ChainJobStore,
  deps: ProcessDeps,
  { workspaceId = null, limit = 20 }: { workspaceId?: string | null; limit?: number } = {},
): Promise<ProcessSummary> {
  const summary: ProcessSummary = { skipped: false, done: 0, pending: 0, failed: 0, needsProductOwner: 0 };
  if (!deps.editors) return { ...summary, skipped: true };
  const now = deps.now ?? (() => new Date());

  if (deps.reassigner) await store.reopenProductOwnerJobs();
  const jobs = await store.claim(workspaceId, limit);

  for (const job of jobs) {
    let update: JobUpdate;
    try {
      update = job.kind === "revoke" ? await revoke(job, store, deps) : await reassign(job, store, deps);
    } catch (error) {
      update = { status: "pending", last_error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
    if (update.status === "pending") {
      update.next_attempt_at ??= later(now(), retryDelayMs(job.attempts));
      summary.pending++;
    } else if (update.status === "done") summary.done++;
    else if (update.status === "failed") summary.failed++;
    else summary.needsProductOwner++;
    if (update.status === "failed" || update.status === "needs_product_owner") {
      console.warn(`[chain-jobs] ${job.kind} for workspace ${job.workspace_id}: ${update.status}: ${update.last_error ?? ""}`);
    }
    await store.finish(job.id, update);
  }
  return summary;
}

async function revoke(job: ChainJob, store: ChainJobStore, deps: ProcessDeps): Promise<JobUpdate> {
  if (!job.address) return { status: "failed", last_error: "The job names no wallet." };
  if (job.network && job.network !== deps.network) {
    // A passkey wallet on the other network: that deployment's server owns it.
    return { status: "pending", last_error: `Waiting for the ${job.network} deployment.`, next_attempt_at: later(deps.now?.() ?? new Date(), 60 * 60_000) };
  }
  if (!deps.revoker) {
    return { status: "pending", last_error: "REVOKER_SECRET_KEY is not set on this server, so removals can't reach the chain yet." };
  }
  const role = await store.roleOfAddress(job.workspace_id, job.address);
  const outcome = await revokeOnChain(
    { workspaceId: job.workspace_id, address: job.address, allowed: allowedChainRole(role) },
    deps.revoker,
    deps.revokeOptions,
  );
  switch (outcome.status) {
    case "done":
      return { status: "done", tx_hash: outcome.txHash, last_error: null };
    case "failed":
      return { status: "failed", last_error: outcome.error };
    case "retry":
      return { status: "pending", last_error: outcome.error };
  }
}

async function reassign(job: ChainJob, store: ChainJobStore, deps: ProcessDeps): Promise<JobUpdate> {
  if (!deps.reassigner) {
    return {
      status: "needs_product_owner",
      last_error: "Handing the workspace over on-chain needs the contract admin's key (CONTRACT_ADMIN_SECRET), which only the product owner holds.",
    };
  }
  if (!job.user_id) return { status: "failed", last_error: "The new owner's account no longer exists." };
  const address = await store.addressOf(job.user_id);
  if (!address) return { status: "pending", last_error: "The new owner has no wallet yet." };

  const current = await deps.reassigner.readOwner(job.workspace_id);
  // Not on-chain, or already theirs: the chain agrees.
  if (current === null || current === address) return { status: "done", last_error: null };
  const hash = await deps.reassigner.reassign(job.workspace_id, address);
  return { status: "done", tx_hash: hash, last_error: null };
}

/** The queue in doqtri's database, through the service role. */
export function supabaseChainJobStore(admin: SupabaseClient, network: string, access: Pick<RegistryAccess, "addressRole">): ChainJobStore {
  return {
    async claim(workspaceId, limit) {
      const { data, error } = await admin.rpc("claim_workspace_chain_jobs", { p_workspace_id: workspaceId, p_limit: limit });
      if (error) throw new Error(`claiming chain jobs failed: ${error.message}`);
      return (data ?? []) as ChainJob[];
    },
    async finish(id, update) {
      const { error } = await admin.from("workspace_chain_jobs").update(update).eq("id", id);
      if (error) console.error(`[chain-jobs] could not record job ${id}: ${error.message}`);
    },
    async reopenProductOwnerJobs() {
      const { error } = await admin
        .from("workspace_chain_jobs")
        .update({ status: "pending", next_attempt_at: new Date().toISOString() })
        .eq("status", "needs_product_owner");
      if (error) console.error(`[chain-jobs] could not reopen handovers: ${error.message}`);
    },
    roleOfAddress: (workspaceId, address) => access.addressRole(workspaceId, address),
    async addressOf(userId) {
      const { data, error } = await admin.rpc("account_chain_address", { p_user_id: userId, p_network: network });
      if (error) throw new Error(`wallet lookup failed: ${error.message}`);
      return (data as string | null) ?? null;
    },
  };
}

/** The contract admin from CONTRACT_ADMIN_SECRET, or null (the usual case: the product owner keeps it). */
export function configuredReassigner(access: Pick<RegistryAccess, "workspace">, registry: string): OwnerReassigner | null {
  const kp = serverKeypair("CONTRACT_ADMIN_SECRET");
  if (!kp) return null;
  return {
    async readOwner(workspaceId) {
      return (await readChainWorkspace(workspaceId))?.owner ?? null;
    },
    async reassign(workspaceId, newOwner) {
      // Built by the one builder that refuses personal workspaces (D-37).
      const func = await buildOwnershipTransfer({ fn: "admin_reassign_owner", workspaceId, newOwner }, access, registry);
      const args: xdr.ScVal[] = func.invokeContract().args();
      return submitRegistryCall(kp, "admin_reassign_owner", args);
    },
  };
}

/**
 * One run of the queue with this deployment's configuration: REGISTRY_EDITORS,
 * the revoker and, when present, the contract admin. `admin` is the
 * service-role client.
 */
export function runChainJobs(admin: SupabaseClient, options: { workspaceId?: string | null; limit?: number } = {}) {
  const access = registryAccess(admin);
  return processChainJobs(
    supabaseChainJobStore(admin, NETWORK, access),
    {
      editors: REGISTRY_EDITORS,
      network: NETWORK,
      revoker: REGISTRY_EDITORS ? configuredRevoker() : null,
      reassigner: REGISTRY_EDITORS ? configuredReassigner(access, CONTRACT_ID) : null,
    },
    options,
  );
}
