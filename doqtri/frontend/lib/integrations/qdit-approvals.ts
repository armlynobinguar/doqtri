import type { SupabaseClient } from "@supabase/supabase-js";
import { nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { qditChainRpcUrl, type ProjectChain, type QditChainNetwork } from "@/lib/integrations/qdit-chain";
import { scanRegistryEvents, type EventSource, type LedgerEvent } from "@/lib/stellar/history";

/**
 * The transaction that approved a qdit milestone version (WP-3.1;
 * server-only), for the receipts on the public audit page.
 *
 * milestone_proof's MilestoneRecord says a milestone is Approved and at
 * which version, but not in which transaction. The approval's event does:
 * `approve_milestone` publishes topics `("qdit", "approve", project_id)`
 * with data `{ milestone_id, approver, version }`, and Stellar RPC returns
 * it with its transaction hash. RPC keeps events for about a week, so doqtri
 * looks the event up when it sees the approval (qdit's webhook, or the ship
 * panel's re-check, WP-2.8) and keeps the hash in qdit_milestone_approvals
 * (20261025131000_qdit_milestone_approvals.sql). Only the chain is asked:
 * qdit's API names a transaction too (`anchor.last_tx_hash`, CONTRACT.md
 * section 7), but that is a pointer, not proof (D-04), and a public receipt
 * must not repeat it as fact.
 *
 * Everything here is best effort. A lookup that fails records nothing and
 * the next sighting of the approval tries again; one that finds nothing
 * keeps the time it first missed (qdit_milestone_approval_misses), and
 * lookups stop once that is GIVE_UP_AFTER_MS old: the approval already
 * existed then, so its event has left RPC's window. The receipt then falls
 * back to the contract's page.
 */

/** The key an approval is recorded under: one approved version on one contract. */
export type ApprovalKey = {
  network: QditChainNetwork;
  contractId: string;
  projectId: string;
  milestoneId: string;
  version: number;
};

export type ApprovalTx = { txHash: string; ledger: number };

/** One lookup's RPC budget: an event scan is a few pages at most. */
const LOOKUP_PAGES = 4;
const LOOKUP_SLICES = 2;
/**
 * The webhook answers qdit within 10 seconds (section 9), and its chain read
 * may already have used up to 5 of them; a lookup gets part of the rest.
 */
export const LOOKUP_TIMEOUT_MS = 3_000;

/**
 * How long after its first empty lookup an approval is looked for again:
 * RPC's event window (about 7 days) plus a day's margin.
 */
export const GIVE_UP_AFTER_MS = 8 * 24 * 60 * 60_000;

const TX_HASH = /^[0-9a-f]{64}$/;

const sym = (name: string) => xdr.ScVal.scvSymbol(name).toXDR("base64");

/** The RPC filter for one project's approvals on its contract. */
export function approvalEventFilter(chain: ProjectChain, projectId: string): rpc.Api.EventFilter {
  return {
    type: "contract",
    contractIds: [chain.contractId],
    topics: [[sym("qdit"), sym("approve"), nativeToScVal(projectId, { type: "string" }).toXDR("base64")]],
  };
}

/**
 * The newest event among `events` that approved `milestoneId` at `version`
 * in `projectId`, or null. Events that do not decode as milestone_proof's
 * MilestoneApproved, or that came from a failed call, are skipped.
 */
export function approvalFromEvents(
  events: readonly LedgerEvent[],
  key: Pick<ApprovalKey, "projectId" | "milestoneId" | "version">,
): ApprovalTx | null {
  let found: ApprovalTx | null = null;
  for (const event of events) {
    if (event.inSuccessfulContractCall === false || event.topic.length !== 3) continue;
    try {
      if (scValToNative(event.topic[0]) !== "qdit" || scValToNative(event.topic[1]) !== "approve") continue;
      if (scValToNative(event.topic[2]) !== key.projectId) continue;
      const data = scValToNative(event.value) as Record<string, unknown> | null;
      if (data?.milestone_id !== key.milestoneId || Number(data?.version) !== key.version) continue;
    } catch {
      continue;
    }
    const txHash = event.txHash.toLowerCase();
    if (!TX_HASH.test(txHash)) continue;
    if (!found || event.ledger > found.ledger) found = { txHash, ledger: event.ledger };
  }
  return found;
}

export type FindApprovalDeps = {
  /** The RPC to scan; defaults to the network's (qditChainRpcUrl). */
  events?: (network: QditChainNetwork) => EventSource;
  timeoutMs?: number;
};

/**
 * Looks the approval of `key` up in RPC's event window. Null when it is not
 * there (older than the window, or the scan's budget ran out first).
 * Throws when RPC could not be read or did not answer in time.
 */
export async function findApprovalTx(key: ApprovalKey, deps: FindApprovalDeps = {}): Promise<ApprovalTx | null> {
  const source = deps.events?.(key.network) ?? new rpc.Server(qditChainRpcUrl(key.network));
  const chain = { network: key.network, contractId: key.contractId };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { events } = await Promise.race([
      scanRegistryEvents(source, [approvalEventFilter(chain, key.projectId)], {
        maxPages: LOOKUP_PAGES,
        slices: LOOKUP_SLICES,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Stellar RPC did not answer in time.")), deps.timeoutMs ?? LOOKUP_TIMEOUT_MS);
      }),
    ]);
    return approvalFromEvents(events, key);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type ApprovalRow = {
  network: QditChainNetwork;
  contract_id: string;
  project_id: string;
  milestone_id: string;
  version: number;
  tx_hash: string;
};

export type ApprovalStore = {
  has(key: ApprovalKey): Promise<boolean>;
  /** Insert-only: an approval already recorded stays as it is. */
  record(key: ApprovalKey, tx: ApprovalTx): Promise<void>;
  /** When a lookup of `key` first found nothing (epoch ms), or null. */
  firstMiss(key: ApprovalKey): Promise<number | null>;
  /** Insert-only: the first miss stands. */
  recordMiss(key: ApprovalKey): Promise<void>;
  /** The recorded approvals of these milestones, any version. */
  forMilestones(milestoneIds: string[]): Promise<ApprovalRow[]>;
};

/** The store over the service-role client. */
export function supabaseApprovalStore(admin: SupabaseClient): ApprovalStore {
  const table = () => admin.from("qdit_milestone_approvals");
  const misses = () => admin.from("qdit_milestone_approval_misses");
  const columns = (key: ApprovalKey) => ({
    network: key.network,
    contract_id: key.contractId,
    project_id: key.projectId,
    milestone_id: key.milestoneId,
    version: key.version,
  });
  const ON_KEY = { onConflict: "network,contract_id,project_id,milestone_id,version", ignoreDuplicates: true };
  return {
    async has(key) {
      const { data, error } = await table().select("tx_hash").match(columns(key)).maybeSingle();
      if (error) throw new Error(`Could not read the milestone's approval: ${error.message}`);
      return data != null;
    },
    async record(key, tx) {
      const { error } = await table().upsert({ ...columns(key), tx_hash: tx.txHash, ledger: tx.ledger }, ON_KEY);
      if (error) throw new Error(`Could not record the milestone's approval: ${error.message}`);
    },
    async firstMiss(key) {
      const { data, error } = await misses().select("first_missed_at").match(columns(key)).maybeSingle();
      if (error) throw new Error(`Could not read the approval's lookups: ${error.message}`);
      const at = data ? Date.parse(String(data.first_missed_at)) : NaN;
      return Number.isFinite(at) ? at : null;
    },
    async recordMiss(key) {
      const { error } = await misses().upsert(columns(key), ON_KEY);
      if (error) throw new Error(`Could not record the approval's lookup: ${error.message}`);
    },
    async forMilestones(milestoneIds) {
      if (milestoneIds.length === 0) return [];
      const { data, error } = await table()
        .select("network, contract_id, project_id, milestone_id, version, tx_hash")
        .in("milestone_id", milestoneIds);
      if (error) throw new Error(`Could not read the milestones' approvals: ${error.message}`);
      return ((data ?? []) as ApprovalRow[]).map((row) => ({ ...row, version: Number(row.version) }));
    },
  };
}

/**
 * Records the approval of `key` unless it already is, or has been missed for
 * longer than RPC keeps events: what the webhook and the re-check call
 * whenever the chain says Approved. A recorded approval costs one indexed
 * read. Never throws; a failure only means the receipt links to the
 * contract instead, until a later sighting finds it.
 */
export type RecordApproval = (key: ApprovalKey) => Promise<void>;

export function approvalRecorder(
  store: ApprovalStore,
  find = findApprovalTx,
  now: () => number = Date.now,
): RecordApproval {
  return async (key) => {
    try {
      if (await store.has(key)) return;
      const missed = await store.firstMiss(key);
      if (missed !== null && now() - missed > GIVE_UP_AFTER_MS) return;
      // A failed lookup throws past this, so only a real "not there" counts as a miss.
      const tx = await find(key);
      if (tx) await store.record(key, tx);
      else await store.recordMiss(key);
    } catch (error) {
      console.error(`[qdit-approvals] ${key.milestoneId}@v${key.version}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
