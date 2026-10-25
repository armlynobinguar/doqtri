import type { ApprovalRow } from "@/lib/integrations/qdit-approvals";
import {
  nodeStatusForMilestone,
  parseQditArtifactRef,
  QDIT_TOOL,
  QditChainError,
  type MilestoneChainRead,
  type MilestoneChainStatus,
  type ProjectChain,
  type QditArtifactRef,
  type QditChainNetwork,
} from "@/lib/integrations/qdit-chain";
import type { ChainNode } from "@/lib/stellar/contract-client";
import type { ChainNodeEvent, DocumentHistory } from "@/lib/stellar/history";

/**
 * qdit receipts on the public audit page (WP-3.1; server-only).
 * docs/integration/CONTRACT.md is the reference; section numbers point into
 * it.
 *
 * A heading whose current DoqtriRegistry record has `tool = "qdit"` was
 * signed from a qdit milestone, and its `artifact_ref` names the milestone
 * and the record version it was signed against (section 10). Its receipt
 * puts three things side by side, all from the chain or doqtri's own
 * records, none from qdit (the page has no qdit token):
 *
 *   - what milestone_proof says about the milestone now
 *     (`get_milestone_status` on the ref's contract and network);
 *   - doqtri's own write that set the record, from the history read the
 *     page already made;
 *   - the transaction that approved the milestone, when doqtri found its
 *     event while it was still in RPC's window (qdit_milestone_approvals,
 *     lib/integrations/qdit-approvals.ts).
 *
 * States (section 12): `confirmed` when the chain backs the record: the
 * milestone's current record is at the ref's own version `V` and its D-19
 * status is the record's (for Verified that is Approved at `V`: fact 4 holds
 * only with fact 3 at the same `V`). `differs` when it says anything else,
 * including a record newer than `V` (the milestone was resubmitted after the
 * heading was signed, so the current record does not speak for `V`), older
 * than `V`, or missing; both sides are shown, and a Verified record is never
 * shown as approved. `unreachable` when it could not be checked.
 *
 * The ref is also held against the note's linked qdit project as doqtri
 * stored it (doc_project_links: the project and its milestone_proof chain,
 * as qdit's API last reported it). An editor signs with their own wallet
 * (D-14), so the ref may name any contract, including a look-alike
 * milestone_proof that answers Approved for anything. A ref is therefore
 * only read, and can only be `confirmed`, when the note is linked to the
 * project it names and that project's stored chain is the ref's network
 * and contract; otherwise it is `differs` with a `mismatch` (section 12's
 * "explicit unverified state naming the mismatch"), and the contract it
 * names is not asked. The page words every mismatch the same way, so it
 * shows nothing from the link row beyond the fact that the ref does not
 * match it.
 *
 * Optionally (section 12, a MAY) the receipt links qdit's public milestone
 * page, `<qdit origin>/p/<slug>/<milestone id>`, built from the slug doqtri
 * stored from qdit's API (doc_project_links). That slug came from a private
 * answer, so the link is shown only once an anonymous GET of the URL, with
 * redirects off, answered a direct 200: qdit then publishes it itself.
 * Answers are kept for PUBLIC_PAGE_TTL_MS.
 *
 * Bounded: at most MAX_RECEIPTS headings are checked per page view, each
 * with one get_node and one get_milestone_status simulation, a few at a
 * time; the rest are counted. Milestone reads are kept for CACHE_TTL_MS
 * per server instance, the same window the page itself revalidates in, and
 * there is at most one qdit page check per checked milestone.
 * Off, and nothing is read, unless NEXT_PUBLIC_QDIT_INTEGRATION=1.
 */

export const MAX_RECEIPTS = 10;
export const CACHE_TTL_MS = 30_000;
/** Section 12: a qdit page check is kept for at most 10 minutes. */
export const PUBLIC_PAGE_TTL_MS = 10 * 60_000;
export const PUBLIC_PAGE_TIMEOUT_MS = 2_000;
const CONCURRENCY = 4;
const MAX_CACHE_ENTRIES = 500;

/**
 * Why a ref does not match the note's linked project: the note has no
 * linked project (`unlinked`), it is linked to another one (`project`), no
 * chain is stored for it yet (`no_chain`), or the stored chain is another
 * network or contract (`chain`).
 */
export type LinkMismatch = "unlinked" | "project" | "no_chain" | "chain";

export type ReceiptCheck =
  | {
      state: "confirmed" | "differs";
      /** What milestone_proof holds now; null when it has no record (MilestoneNotFound). */
      chain: { status: MilestoneChainStatus; version: number } | null;
      /** The ledger the read saw. */
      ledger: number;
      mismatch?: undefined;
    }
  | {
      /** The ref does not match the note's linked project, so its contract was not read. */
      state: "differs";
      mismatch: LinkMismatch;
    }
  | {
      state: "unreachable";
      /** `rpc`: Stellar did not answer. `contract`: the named contract could not be read as milestone_proof. `invalid_ref`: the ref does not follow section 10. `link`: the note's linked project could not be read to check the ref against. */
      reason: "rpc" | "contract" | "invalid_ref" | "link";
    };

/** What a check read from milestone_proof, or null when it read nothing. */
export function chainRead(check: ReceiptCheck): { chain: { status: MilestoneChainStatus; version: number } | null; ledger: number } | null {
  return check.state === "unreachable" || check.mismatch ? null : check;
}

/** The note's linked qdit project as doqtri stored it (doc_project_links). */
export type LinkedProject = {
  projectId: string;
  slug: string;
  /** Its milestone_proof contract as qdit last reported it; null until registered. */
  chain: ProjectChain | null;
};

/** Whether `ref` names the note's linked project on that project's own chain. */
export function linkMismatch(ref: QditArtifactRef, project: LinkedProject | null): LinkMismatch | null {
  if (!project) return "unlinked";
  if (ref.projectId !== project.projectId) return "project";
  if (!project.chain) return "no_chain";
  if (ref.network !== project.chain.network || ref.contractId !== project.chain.contractId) return "chain";
  return null;
}

export type QditReceipt = {
  nodeId: string;
  /** The heading's current DoqtriRegistry record. */
  record: { status: string; artifactRef: string };
  ref: QditArtifactRef | null;
  /** doqtri's write that set the record, when the history read found it. */
  signing: ChainNodeEvent | null;
  check: ReceiptCheck;
  /** The approval of the version the chain holds, when the chain says Approved and doqtri recorded it. */
  approvalTxHash: string | null;
  /** qdit's public page for the milestone, only once qdit was seen publishing it. */
  qditPageUrl: string | null;
};

export type QditReceipts = {
  receipts: QditReceipt[];
  /** Headings signed from qdit beyond MAX_RECEIPTS, not checked on this view. */
  more: number;
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Whether the chain's word backs a record signed against `ref` (see the
 * states above). Only a record at `ref.version` itself can: Approved is
 * terminal in milestone_proof (submit_milestone_proof refuses an approved
 * milestone), so a record Approved at a later version means `ref.version`
 * was rejected and resubmitted, not approved.
 */
export function checkReceipt(record: { status: string }, ref: QditArtifactRef, read: MilestoneChainRead): ReceiptCheck {
  const chain = read.record ? { status: read.record.status, version: read.record.version } : null;
  const backs = chain != null && chain.version === ref.version && nodeStatusForMilestone(chain.status) === record.status;
  return { state: backs ? "confirmed" : "differs", chain, ledger: read.ledger };
}

/** The newest write in `history` that left `nodeId` with exactly this record. */
function signingEvent(history: DocumentHistory, nodeId: string, record: ChainNode | ChainNodeEvent): ChainNodeEvent | null {
  let found: ChainNodeEvent | null = null;
  for (const event of history.nodeEvents) {
    if (
      event.nodeId === nodeId &&
      event.status === record.status &&
      event.tool === record.tool &&
      event.artifactRef === record.artifactRef
    ) {
      found = event;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The milestone read cache
// ---------------------------------------------------------------------------

export type ReadCache<T = MilestoneChainRead> = {
  get(key: string, load: () => Promise<T>): Promise<T>;
};

/** Reads kept for `ttlMs`; a failed read is not kept, so the next view asks again. */
export function createReadCache<T = MilestoneChainRead>(
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): ReadCache<T> {
  const ttl = options.ttlMs ?? CACHE_TTL_MS;
  const max = options.maxEntries ?? MAX_CACHE_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttl) return hit.value;
      entries.delete(key);
      const value = load();
      entries.set(key, { at: now(), value });
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
      return value;
    },
  };
}

/** This server instance's caches. */
export const receiptReadCache = createReadCache();
export const qditPageCache = createReadCache<boolean>({ ttlMs: PUBLIC_PAGE_TTL_MS });

// ---------------------------------------------------------------------------
// qdit's public milestone page (section 12)
// ---------------------------------------------------------------------------

/** `<qdit origin>/p/<slug>/<milestone id>`, exactly as section 12 builds it. */
export function qditMilestonePageUrl(origin: string, slug: string, milestoneId: string): string {
  return `${origin.replace(/\/+$/, "")}/p/${encodeURIComponent(slug)}/${milestoneId}`;
}

/**
 * Whether qdit publishes `url`: an anonymous GET (no token, no cookies),
 * redirects off, answered with a direct 200. A redirect, any other status,
 * a network error or a timeout all count as not published. Never throws.
 */
export async function isQditPagePublished(
  url: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(options.timeoutMs ?? PUBLIC_PAGE_TIMEOUT_MS),
    });
    // Only the status matters; don't hold the connection for the body.
    response.body?.cancel().catch(() => {});
    return response.status === 200 && response.type !== "opaqueredirect" && !response.redirected;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type ReceiptDeps = {
  /** Defaults to NEXT_PUBLIC_QDIT_INTEGRATION === "1". */
  enabled?: boolean;
  /** The heading's current record (DoqtriRegistry.readNode). */
  readNode: (docId: string, nodeId: string) => Promise<ChainNode | null>;
  /** milestone_proof.get_milestone_status (readMilestoneRecord). */
  readMilestone: (chain: ProjectChain, projectId: string, milestoneId: string) => Promise<MilestoneChainRead>;
  /** Recorded approvals of these milestones (qdit_milestone_approvals). */
  approvals: (milestoneIds: string[]) => Promise<ApprovalRow[]>;
  /**
   * The project the note is linked to, as doqtri stored it
   * (doc_project_links); null when none. Read once per view, and only when
   * some heading names qdit.
   */
  linkedProject: () => Promise<LinkedProject | null>;
  /**
   * The optional link to qdit's public milestone page. Leave it out (no
   * qdit origin configured) and no receipt links qdit.
   */
  qditPage?: {
    /** The qdit origin (section 1), e.g. https://qdit.atalusan.com. */
    origin: string;
    /** Defaults to isQditPagePublished. */
    isPublished?: (url: string) => Promise<boolean>;
    cache?: ReadCache<boolean>;
  };
  cache?: ReadCache;
  max?: number;
};

const cacheKey = (network: QditChainNetwork, ref: QditArtifactRef) =>
  `${network}|${ref.contractId}|${ref.projectId}|${ref.milestoneId}`;

/**
 * The receipts for `docId`, or null when there are none to show: the
 * integration is off, history could not be read, or no heading's latest
 * record names qdit. Null renders nothing, so the page is then exactly
 * what it was without the integration.
 */
export async function loadQditReceipts(
  docId: string,
  history: DocumentHistory | null,
  deps: ReceiptDeps,
): Promise<QditReceipts | null> {
  if (!(deps.enabled ?? process.env.NEXT_PUBLIC_QDIT_INTEGRATION === "1")) return null;
  // The chain cannot list a document's nodes; its history can.
  const candidates = (history?.nodes ?? []).filter((node) => node.tool === QDIT_TOOL);
  if (!history || candidates.length === 0) return null;

  const max = deps.max ?? MAX_RECEIPTS;
  const checked = candidates.slice(0, max);
  const cache = deps.cache ?? receiptReadCache;
  // Undefined when it could not be read: nothing is then checked against it.
  const linked: Promise<LinkedProject | null | undefined> = deps.linkedProject().catch(() => undefined);

  const one = async (latest: ChainNodeEvent): Promise<QditReceipt | null> => {
    // The record as the contract holds it now; the history's latest write
    // stands in for it when the contract can't be asked.
    let record: ChainNode | ChainNodeEvent = latest;
    try {
      const current = await deps.readNode(docId, latest.nodeId);
      if (!current) return null;
      record = current;
    } catch {
      // Keep the history's.
    }
    if (record.tool !== QDIT_TOOL) return null;

    const base = {
      nodeId: latest.nodeId,
      record: { status: record.status, artifactRef: record.artifactRef },
      signing: signingEvent(history, latest.nodeId, record),
      approvalTxHash: null,
      qditPageUrl: null,
    };
    const ref = parseQditArtifactRef(record.artifactRef);
    if (!ref) return { ...base, ref: null, check: { state: "unreachable", reason: "invalid_ref" } };

    // Only the linked project's own contract is asked (see above).
    const project = await linked;
    if (project === undefined) return { ...base, ref, check: { state: "unreachable", reason: "link" } };
    const mismatch = linkMismatch(ref, project);
    if (mismatch) return { ...base, ref, check: { state: "differs", mismatch } };

    try {
      const read = await cache.get(cacheKey(ref.network, ref), () =>
        deps.readMilestone({ network: ref.network, contractId: ref.contractId }, ref.projectId, ref.milestoneId),
      );
      return { ...base, ref, check: checkReceipt(record, ref, read) };
    } catch (error) {
      const reason = error instanceof QditChainError && error.kind !== "unreachable" ? "contract" : "rpc";
      return { ...base, ref, check: { state: "unreachable", reason } };
    }
  };

  const receipts: QditReceipt[] = [];
  for (let i = 0; i < checked.length; i += CONCURRENCY) {
    for (const receipt of await Promise.all(checked.slice(i, i + CONCURRENCY).map(one))) {
      if (receipt) receipts.push(receipt);
    }
  }

  await Promise.all([attachApprovals(receipts, deps), attachQditPages(receipts, deps, await linked)]);

  if (receipts.length === 0 && candidates.length <= max) return null;
  return { receipts, more: candidates.length - checked.length };
}

/** One query for every approval the chain now shows. */
async function attachApprovals(receipts: QditReceipt[], deps: ReceiptDeps): Promise<void> {
  const approved = receipts.filter((r) => r.ref && chainRead(r.check)?.chain?.status === "Approved");
  if (approved.length > 0) {
    let rows: ApprovalRow[] = [];
    try {
      rows = await deps.approvals([...new Set(approved.map((r) => r.ref!.milestoneId))]);
    } catch {
      // The receipt links to the contract instead.
    }
    for (const receipt of approved) {
      const { ref, check } = receipt;
      const version = chainRead(check)?.chain?.version;
      const row = rows.find(
        (r) =>
          r.network === ref!.network &&
          r.contract_id === ref!.contractId &&
          r.project_id === ref!.projectId &&
          r.milestone_id === ref!.milestoneId &&
          Number(r.version) === version,
      );
      receipt.approvalTxHash = row?.tx_hash ?? null;
    }
  }
}

/**
 * qdit's public page for each receipt's milestone, when the ref matched the
 * note's linked project (so its contract was read) and qdit answers that
 * page anonymously. One check per distinct page (at most one per checked
 * milestone), cached.
 */
async function attachQditPages(
  receipts: QditReceipt[],
  deps: ReceiptDeps,
  project: LinkedProject | null | undefined,
): Promise<void> {
  const page = deps.qditPage;
  if (!page || !project) return;
  const isPublished = page.isPublished ?? ((url: string) => isQditPagePublished(url));
  const cache = page.cache ?? qditPageCache;
  const { projectId, slug } = project;
  const checks = new Map<string, Promise<boolean>>();
  await Promise.all(
    receipts.map(async (receipt) => {
      if (receipt.ref?.projectId !== projectId || !chainRead(receipt.check)) return;
      const url = qditMilestonePageUrl(page.origin, slug, receipt.ref.milestoneId);
      if (!checks.has(url)) checks.set(url, cache.get(url, () => isPublished(url)).catch(() => false));
      if (await checks.get(url)) receipt.qditPageUrl = url;
    }),
  );
}

/** stellar.expert's page for a transaction or contract on a qdit network (`public` is its mainnet slug). */
export function qditExplorerUrl(network: QditChainNetwork, kind: "tx" | "contract", id: string): string {
  return `https://stellar.expert/explorer/${network === "mainnet" ? "public" : "testnet"}/${kind}/${id}`;
}
