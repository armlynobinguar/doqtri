import type { Metadata } from "next";
import Link from "next/link";
import { HashCheck } from "@/components/audit/hash-check";
import { QditReceiptsSection } from "@/components/audit/qdit-receipts";
import { SignerAddress } from "@/components/audit/signer-address";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { StatusTag } from "@/components/ui/status-tag";
import { DoqtriRegistry, type ChainDocument } from "@/lib/stellar/contract-client";
import { StrKey } from "@stellar/stellar-sdk";
import {
  CONTRACT_ID,
  IS_MAINNET,
  expertContractUrl,
  expertTxUrl,
  labContractUrl,
} from "@/lib/stellar/config";
import {
  getDocumentHistory,
  getDocumentTtl,
  type ChainNodeEvent,
  type DocumentHistory,
  type DocumentTtl,
} from "@/lib/stellar/history";
import { sha256Hex } from "@/lib/stellar/hash";
import { parseSignerRemovals, removalInEffect, type SignerRemoval } from "@/lib/stellar/signers";
import { buildMindmap, type MindmapNode } from "@/lib/mindmap";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { supabaseApprovalStore } from "@/lib/integrations/qdit-approvals";
import { isProjectChain, readMilestoneRecord } from "@/lib/integrations/qdit-chain";
import { qditIntegrationEnabled, qditPublicOrigin } from "@/lib/integrations/qdit-config";
import { loadQditReceipts, type LinkedProject, type QditReceipts } from "@/lib/integrations/qdit-receipts";

/*
 * Public, read-only audit page. Everything shown comes from the ledger through
 * a signer-less client, with two exceptions from doqtri's database: heading
 * labels, which the owner must opt into and which are withheld unless the
 * private note still hashes to the anchored hash; and when a signer was
 * removed from the note's workspace, to flag entries signed after that
 * (WP-1.8). Signers are shown by wallet address only, never by name.
 *
 * With NEXT_PUBLIC_QDIT_INTEGRATION=1, headings signed from a qdit milestone
 * also get a receipt (WP-3.1): qdit's milestone_proof contract read on the
 * record's own network, the approving transaction when doqtri recorded it,
 * and qdit's public milestone page once qdit answers it anonymously. The
 * note's doc_project_links row says which project and contract a record
 * may name (a record naming any other is shown as unverified, without the
 * row's values); its slug is shown only as part of a URL qdit itself
 * publishes. Each receipt folds out the heading's full proof chain (WP-3.3,
 * CONTRACT.md section 12: plan version, submitted, approved, verified),
 * from the same reads. Without the flag, or with no such heading, the page
 * is unchanged.
 */
export const revalidate = 30;

export const metadata: Metadata = {
  title: "Doqtri audit",
  description: "Verify a Doqtri document against its record on Stellar.",
};

/*
 * App notes use Supabase UUIDs, but the contract takes any string and earlier
 * demo documents were anchored under slugs. Accept both shapes; reject
 * anything else before a single query runs.
 */
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Audit =
  | { state: "invalid" | "not-anchored" | "unreachable" }
  | {
      state: "anchored";
      doc: ChainDocument;
      history: DocumentHistory | null;
      ttl: DocumentTtl | null;
      labels: Map<string, string> | null;
      removals: SignerRemoval[];
      receipts: QditReceipts | null;
    };

async function loadAudit(docId: string): Promise<Audit> {
  if (!DOC_ID.test(docId)) return { state: "invalid" };

  let doc: ChainDocument | null;
  try {
    doc = await DoqtriRegistry.readDocument(docId);
  } catch {
    return { state: "unreachable" };
  }
  if (!doc) return { state: "not-anchored" };

  // History and TTL are enrichments: the page stands on get_document alone.
  // History also reads removed signers' own feeds, so it waits for them.
  const removalsLoaded = loadSignerRemovals(docId).catch(() => []);
  const [history, ttl, labels, removals] = await Promise.all([
    removalsLoaded.then((removals) =>
      getDocumentHistory(docId, {
        removedSigners: removals.map(({ address, removedAt, restoredAt }) => ({ address, removedAt, restoredAt })),
      }).catch(() => null),
    ),
    getDocumentTtl(docId).catch(() => null),
    loadPublicHeadings(docId, doc.contentHash).catch(() => null),
    removalsLoaded,
  ]);

  const receipts = qditIntegrationEnabled() ? await loadReceipts(docId, history).catch(() => null) : null;
  return { state: "anchored", doc, history, ttl, labels, removals, receipts };
}

/**
 * The qdit receipts (WP-3.1): chain reads, plus approvals doqtri recorded
 * and the qdit page link. The service-role client is made only when a
 * receipt needs it, so a deployment without it still shows the chain's side.
 */
async function loadReceipts(docId: string, history: DocumentHistory | null): Promise<QditReceipts | null> {
  const origin = qditPublicOrigin();
  return loadQditReceipts(docId, history, {
    enabled: true,
    readNode: (id, nodeId) => DoqtriRegistry.readNode(id, nodeId),
    readMilestone: (chain, projectId, milestoneId) => readMilestoneRecord(chain, projectId, milestoneId),
    approvals: (milestoneIds) => supabaseApprovalStore(createSupabaseAdminClient()).forMilestones(milestoneIds),
    linkedProject: () => loadLinkedProject(docId),
    qditPage: origin ? { origin } : undefined,
  });
}

/**
 * The qdit project the note is linked to (D-09) and its chain, as doqtri
 * stored them. Only app notes can be linked.
 */
async function loadLinkedProject(docId: string): Promise<LinkedProject | null> {
  if (!UUID.test(docId)) return null;
  const { data, error } = await createSupabaseAdminClient()
    .from("doc_project_links")
    .select("project_id, project_slug, chain_network, chain_contract_id")
    .eq("document_id", docId)
    .maybeSingle();
  if (error) throw new Error(`doc project link unavailable: ${error.message}`);
  if (!data) return null;
  const chain = { network: data.chain_network, contractId: data.chain_contract_id };
  return {
    projectId: String(data.project_id),
    slug: String(data.project_slug),
    chain: isProjectChain(chain) ? chain : null,
  };
}

/**
 * When each wallet that has signed for the note's workspace lost the right
 * to (workspace_member_removals). Only app notes have a workspace.
 */
async function loadSignerRemovals(docId: string): Promise<SignerRemoval[]> {
  if (!UUID.test(docId)) return [];
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("signer_removals_for_document", { p_document_id: docId });
  if (error) throw new Error(`signer removals unavailable: ${error.message}`);
  return parseSignerRemovals(data);
}

/**
 * Node id -> heading label, only when the owner opted in and the private note
 * is byte-identical to what is anchored. Node ids are positional (`h0`, `h1`,
 * ...), so labels from a different draft could be attached to the wrong node.
 */
async function loadPublicHeadings(
  docId: string,
  anchoredHash: string,
): Promise<Map<string, string> | null> {
  // Only app notes have a row to publish headings from.
  if (!UUID.test(docId)) return null;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("documents")
    .select("title, markdown, publish_headings")
    .eq("id", docId)
    .maybeSingle();
  if (error || !data?.publish_headings) return null;

  const markdown = String(data.markdown ?? "");
  if ((await sha256Hex(markdown)) !== anchoredHash) return null;

  const labels = new Map<string, string>();
  const walk = (node: MindmapNode) => {
    labels.set(node.id, node.label);
    node.children.forEach(walk);
  };
  walk(buildMindmap(String(data.title ?? ""), markdown));
  return labels;
}

function formatDate(value: string | number | Date): string {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
}

/** Brand status colors for contract node statuses. */
function statusTone(status: string) {
  switch (status) {
    case "Verified":
      return "onchain" as const;
    case "Built":
      return "verified" as const;
    case "Building":
      return "info" as const;
    default:
      return "planned" as const;
  }
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export default async function AuditPage(props: PageProps<"/d/[docId]">) {
  const { docId } = await props.params;
  const audit = await loadAudit(docId);
  const network = IS_MAINNET ? "Mainnet" : "Testnet";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6 [--mark-fill:var(--brand-elevated)]">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="inline-flex items-center gap-2 text-[17px] font-extrabold tracking-[-0.045em]">
          <DoqtriMark className="h-auto w-7" glow={false} title="" />
          Doqtri <span className="eyebrow ml-1 text-[10px]">audit</span>
        </Link>
        <StatusTag tone="onchain">Stellar {network}</StatusTag>
      </header>

      {audit.state === "anchored" ? (
        <Anchored docId={docId} {...audit} />
      ) : (
        <EmptyState docId={docId} state={audit.state} />
      )}

      <footer className="text-muted-foreground border-t border-[var(--glass-lo)] pt-5 text-[12px]">
        Read directly from the DoqtriRegistry contract{" "}
        <a
          className="text-primary font-mono underline-offset-2 hover:underline"
          href={labContractUrl()}
          target="_blank"
          rel="noreferrer"
        >
          {shortHash(CONTRACT_ID)}
        </a>
        . No account or wallet is needed to view this page.
      </footer>
    </main>
  );
}

function EmptyState({
  docId,
  state,
}: {
  docId: string;
  state: "invalid" | "not-anchored" | "unreachable";
}) {
  const copy = {
    invalid: {
      title: "Not a Doqtri document id",
      body: "Check the link you were given — a document id is letters, digits, dashes and underscores, like 1b4e28ba-2fa1-11d2-883f-0016d3cca427.",
    },
    "not-anchored": {
      title: "Not anchored",
      body: "No record for this document exists on the Stellar ledger. The owner may not have registered it yet, or the link points at a different network.",
    },
    unreachable: {
      title: "Ledger unreachable",
      body: "The Stellar network could not be queried just now. This says nothing about the document — try again in a moment.",
    },
  }[state];

  return (
    <section className="glass grid gap-2 rounded-2xl px-6 py-7">
      <h1 className="display text-2xl">{copy.title}</h1>
      <p className="text-muted-foreground text-[14px]">{copy.body}</p>
      <p className="text-muted-foreground font-mono text-[12px] break-all">{docId}</p>
    </section>
  );
}

function Anchored({
  docId,
  doc,
  history,
  ttl,
  labels,
  removals,
  receipts,
}: {
  docId: string;
  doc: ChainDocument;
  history: DocumentHistory | null;
  ttl: DocumentTtl | null;
  labels: Map<string, string> | null;
  removals: SignerRemoval[];
  receipts: QditReceipts | null;
}) {
  // An incomplete history (passkey-wallet owners only) numbers versions by
  // what was found, which can be wrong, so it labels nothing here.
  const numbered = history?.incomplete ? [] : (history?.versions ?? []);
  const current = numbered.find((v) => v.version === doc.version);
  // Hash comparison must include every version, but the chain value wins for
  // the current one in case history is unavailable or lagging.
  const versions = [
    ...numbered.filter((v) => v.version !== doc.version),
    { version: doc.version, contentHash: doc.contentHash },
  ];
  const lateSigned = (e: { signer: string | null; closedAt: string }) =>
    e.signer != null && removalInEffect(e.signer, e.closedAt, removals) != null;
  // nodeEvents holds every status, including ones a later status replaced.
  const signedAfterRemoval =
    history != null && [...history.versions, ...history.nodeEvents].some(lateSigned);
  // Per node: replaced statuses a removed wallet signed, so they stay visible.
  const lateReplaced = new Map<string, ChainNodeEvent[]>();
  for (const event of history?.nodeEvents ?? []) {
    if (!lateSigned(event) || history?.nodes.includes(event)) continue;
    lateReplaced.set(event.nodeId, [...(lateReplaced.get(event.nodeId) ?? []), event]);
  }

  return (
    <>
      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="display text-3xl sm:text-4xl">
            Anchored document
          </h1>
          <StatusTag tone="verified" className="font-mono">
            v{doc.version}
          </StatusTag>
        </div>
        <dl className="glass grid gap-x-6 gap-y-3.5 rounded-2xl px-6 py-5 text-[13px] sm:grid-cols-[max-content_1fr] sm:items-baseline">
          <Field label="Document id">
            <span className="font-mono break-all">{docId}</span>
          </Field>
          <Field label="SHA-256">
            <span className="font-mono break-all">{doc.contentHash}</span>
          </Field>
          <Field label="Owner">
            <span className="font-mono break-all">{doc.owner ?? "—"}</span>
            {doc.owner && StrKey.isValidContract(doc.owner) ? (
              <span className="text-muted-foreground block text-[12px]">
                Passkey wallet (a contract account) ·{" "}
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href={expertContractUrl(doc.owner)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Stellar Expert →
                </a>
              </span>
            ) : null}
          </Field>
          <Field label="Last updated">
            {formatDate(doc.updatedAt)}
            {current ? (
              <>
                {" · "}
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href={expertTxUrl(current.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  transaction →
                </a>
              </>
            ) : null}
          </Field>
          {ttl ? (
            <Field label="Ledger entry">
              Live until ledger {ttl.liveUntilLedger.toLocaleString("en-US")} (about{" "}
              {formatDate(ttl.expiresAt)}). Each write extends it; a dormant
              entry can be restored — see the verifier guide.
            </Field>
          ) : null}
        </dl>
      </section>

      <section className="grid gap-3">
        <h2 className="text-xl font-extrabold tracking-[-0.03em]">Check a copy</h2>
        <p className="text-muted-foreground text-[14px]">
          If you were sent this document, confirm it is exactly what the owner
          anchored.
        </p>
        <HashCheck versions={versions} currentVersion={doc.version} />
      </section>

      <section className="grid gap-3">
        <h2 className="text-xl font-extrabold tracking-[-0.03em]">Version history</h2>
        {history?.incomplete ? (
          <p data-testid="history-incomplete" className="text-warning text-[13px]">
            The contract reports v{doc.version}, but only {history.versions.length} of its
            transactions were found, so some versions are missing below. The current version
            above is read directly from the contract.
          </p>
        ) : null}
        {history?.partial ? (
          <p data-testid="history-partial" className="text-muted-foreground text-[13px]">
            Writes by the note&apos;s editors are found by reading a bounded stretch of the
            ledger, and that read stopped before its end just now, so a recent write by an
            editor may be missing below.
          </p>
        ) : null}
        {signedAfterRemoval ? (
          <p data-testid="signed-after-removal" className="text-warning text-[13px]">
            Some entries on this page were signed by a wallet after Doqtri had removed it from
            this note&apos;s workspace. They are marked &quot;Signed after removal&quot;.{" "}
            {history?.workspace
              ? "The ledger accepted them because the removal had not yet reached the note's on-chain editor list."
              : "This note has no on-chain editor list, so the ledger only checks that the note's owner signed; the removal is Doqtri's record."}
          </p>
        ) : null}
        {history && history.versions.length > 0 ? (
          <ol className="glass divide-y divide-[var(--glass-lo)] rounded-2xl text-[13px]">
            {[...history.versions].reverse().map((v) => (
              <li
                key={v.txHash}
                className="grid gap-1 px-4 py-2.5 sm:grid-cols-[3rem_1fr_auto] sm:items-center sm:gap-4"
              >
                <span className="font-mono">{history.incomplete ? "·" : `v${v.version}`}</span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="text-muted-foreground font-mono break-all" title={v.contentHash}>
                    {shortHash(v.contentHash)} · {formatDate(v.closedAt)}
                  </span>
                  <Signer signer={v.signer} fromOwner={v.signerFrom === "owner"} closedAt={v.closedAt} removals={removals} />
                </span>
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href={expertTxUrl(v.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Stellar Expert →
                </a>
              </li>
            ))}
          </ol>
        ) : history?.incomplete ? null : (
          <p className="text-muted-foreground text-[14px]">
            History could not be read from Horizon right now. The current
            version above is read directly from the contract.
          </p>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="text-xl font-extrabold tracking-[-0.03em]">Build status</h2>
        {history && history.nodes.length > 0 ? (
          <>
            <ul className="glass divide-y divide-[var(--glass-lo)] rounded-2xl text-[13px]">
              {history.nodes.map((node) => (
                <li
                  key={node.nodeId}
                  className="grid gap-1 px-4 py-2.5 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-4"
                >
                  <span className="min-w-0">
                    <span className="block truncate">
                      {labels?.get(node.nodeId) ?? (
                        <span className="font-mono">{node.nodeId}</span>
                      )}
                    </span>
                    <span className="text-muted-foreground block truncate text-[12px]">
                      {node.tool || "—"}
                      {node.artifactRef ? ` · ${node.artifactRef}` : ""}
                    </span>
                    <Signer
                      signer={node.signer}
                      fromOwner={node.signerFrom === "owner"}
                      closedAt={node.closedAt}
                      removals={removals}
                    />
                    {(lateReplaced.get(node.nodeId) ?? []).map((event) => (
                      <span
                        key={event.txHash}
                        data-testid="replaced-after-removal"
                        className="text-muted-foreground mt-1 block text-[12px]"
                      >
                        Earlier: {event.status} on {formatDate(event.closedAt)} ·{" "}
                        <a
                          className="text-primary underline-offset-2 hover:underline"
                          href={expertTxUrl(event.txHash)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          tx →
                        </a>
                        <Signer
                          signer={event.signer}
                          fromOwner={event.signerFrom === "owner"}
                          closedAt={event.closedAt}
                          removals={removals}
                        />
                      </span>
                    ))}
                  </span>
                  <span className="text-muted-foreground inline-flex items-center gap-2 text-[12px]">
                    <StatusTag tone={statusTone(node.status)}>{node.status}</StatusTag>
                    as of v{node.docVersion}
                  </span>
                  <a
                    className="text-primary underline-offset-2 hover:underline"
                    href={expertTxUrl(node.txHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx →
                  </a>
                </li>
              ))}
            </ul>
            {labels ? null : (
              <p className="text-muted-foreground text-[12px]">
                Nodes are identified by position in the plan (root, h0, h1, …).
                Heading names are private unless the owner chooses to publish
                them.
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground text-[14px]">
            No node statuses have been recorded for this document.
          </p>
        )}
      </section>

      {receipts ? (
        <QditReceiptsSection receipts={receipts} labels={labels} chain={{ docId, doc, history }} />
      ) : null}

      <section className="glass grid gap-5 rounded-2xl px-6 py-5 text-[13px] sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <h2 className="eyebrow text-foreground/80">What this proves</h2>
          <ul className="text-muted-foreground list-disc space-y-1 pl-4">
            <li>
              The wallet shown signed this exact hash at the time shown (where none is shown,
              the note&apos;s owner at that time did).
            </li>
            <li>A copy that matches has not changed by a single byte since.</li>
            <li>Each build status was recorded by the wallet shown, in order.</li>
          </ul>
        </div>
        <div className="grid content-start gap-1.5">
          <h2 className="eyebrow text-foreground/80">What it does not prove</h2>
          <ul className="text-muted-foreground list-disc space-y-1 pl-4">
            <li>
              Availability: only the hash is on-chain, so the text cannot be
              recovered from Stellar.
            </li>
            <li>
              Accuracy: AI-assisted conversion may have shaped the text. The
              ledger attests to what the owner anchored, not that it is correct.
            </li>
            <li>That a &quot;Built&quot; status was independently checked.</li>
            <li>
              Who is behind a wallet: signers are shown by address only. Whether one
              had been removed from the workspace comes from Doqtri&apos;s records,
              not the ledger.
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}

/**
 * Who signed an entry, and a flag when Doqtri had removed that wallet from
 * the note's workspace before the entry's ledger closed. An owner-only
 * entry whose signing wallet could not be read (`signer` null) names the
 * role, not the current owner, who may not have owned the note then.
 */
function Signer({
  signer,
  fromOwner,
  closedAt,
  removals,
}: {
  signer: string | null;
  fromOwner: boolean;
  closedAt: string;
  removals: SignerRemoval[];
}) {
  const removal = signer ? removalInEffect(signer, closedAt, removals) : null;
  return (
    <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
      <span className="inline-flex items-center gap-1">
        {signer ? (
          <>
            signed by <SignerAddress address={signer} owner={fromOwner} />
          </>
        ) : (
          <span data-testid="signer-owner-at-time">signed by the note&apos;s owner at the time</span>
        )}
      </span>
      {removal ? (
        <StatusTag
          tone="danger"
          data-testid="signed-after-removal-entry"
          title={`Doqtri removed this wallet from the note's workspace ${formatDate(removal.removedAt)}, before this entry was signed`}
        >
          Signed after removal
        </StatusTag>
      ) : null}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="eyebrow text-[10px]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
