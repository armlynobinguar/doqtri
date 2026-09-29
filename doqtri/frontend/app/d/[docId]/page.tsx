import type { Metadata } from "next";
import Link from "next/link";
import { HashCheck } from "@/components/audit/hash-check";
import { DoqtriRegistry, type ChainDocument } from "@/lib/stellar/contract-client";
import {
  CONTRACT_ID,
  IS_MAINNET,
  expertTxUrl,
  labContractUrl,
} from "@/lib/stellar/config";
import {
  getDocumentHistory,
  getDocumentTtl,
  type DocumentHistory,
  type DocumentTtl,
} from "@/lib/stellar/history";
import { sha256Hex } from "@/lib/stellar/hash";
import { buildMindmap, type MindmapNode } from "@/lib/mindmap";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/*
 * Public, read-only audit page. Everything shown comes from the ledger through
 * a signer-less client; the one exception is heading labels, which the owner
 * must opt into and which are withheld unless the private note still hashes to
 * the anchored hash.
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
  const [history, ttl, labels] = await Promise.all([
    getDocumentHistory(docId).catch(() => null),
    getDocumentTtl(docId).catch(() => null),
    loadPublicHeadings(docId, doc.contentHash).catch(() => null),
  ]);

  return { state: "anchored", doc, history, ttl, labels };
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

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export default async function AuditPage(props: PageProps<"/d/[docId]">) {
  const { docId } = await props.params;
  const audit = await loadAudit(docId);
  const network = IS_MAINNET ? "Mainnet" : "Testnet";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="font-medium tracking-tight">
          Doqtri <span className="text-muted-foreground font-normal">audit</span>
        </Link>
        <span className="border-border text-muted-foreground rounded-full border px-2.5 py-0.5 text-[12px]">
          Stellar {network}
        </span>
      </header>

      {audit.state === "anchored" ? (
        <Anchored docId={docId} {...audit} />
      ) : (
        <EmptyState docId={docId} state={audit.state} />
      )}

      <footer className="text-muted-foreground border-border border-t pt-4 text-[12px]">
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
    <section className="border-border grid gap-2 rounded-lg border px-5 py-6">
      <h1 className="text-lg font-semibold tracking-tight">{copy.title}</h1>
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
}: {
  docId: string;
  doc: ChainDocument;
  history: DocumentHistory | null;
  ttl: DocumentTtl | null;
  labels: Map<string, string> | null;
}) {
  const current = history?.versions.find((v) => v.version === doc.version);
  // Hash comparison must include every version, but the chain value wins for
  // the current one in case history is unavailable or lagging.
  const versions = [
    ...(history?.versions ?? []).filter((v) => v.version !== doc.version),
    { version: doc.version, contentHash: doc.contentHash },
  ];

  return (
    <>
      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Anchored document
          </h1>
          <span className="border-primary/40 text-primary rounded border px-2 py-0.5 font-mono text-[13px]">
            v{doc.version}
          </span>
        </div>
        <dl className="border-border grid gap-x-6 gap-y-3 rounded-lg border px-5 py-4 text-[13px] sm:grid-cols-[max-content_1fr]">
          <Field label="Document id">
            <span className="font-mono break-all">{docId}</span>
          </Field>
          <Field label="SHA-256">
            <span className="font-mono break-all">{doc.contentHash}</span>
          </Field>
          <Field label="Owner">
            <span className="font-mono break-all">{doc.owner ?? "—"}</span>
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
        <h2 className="text-lg font-semibold tracking-tight">Check a copy</h2>
        <p className="text-muted-foreground text-[14px]">
          If you were sent this document, confirm it is exactly what the owner
          anchored.
        </p>
        <HashCheck versions={versions} currentVersion={doc.version} />
      </section>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Version history</h2>
        {history && history.versions.length > 0 ? (
          <ol className="border-border divide-border divide-y rounded-lg border text-[13px]">
            {[...history.versions].reverse().map((v) => (
              <li
                key={v.txHash}
                className="grid gap-1 px-4 py-2.5 sm:grid-cols-[3rem_1fr_auto] sm:items-center sm:gap-4"
              >
                <span className="font-mono">v{v.version}</span>
                <span className="text-muted-foreground font-mono break-all" title={v.contentHash}>
                  {shortHash(v.contentHash)} · {formatDate(v.closedAt)}
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
        ) : (
          <p className="text-muted-foreground text-[14px]">
            History could not be read from Horizon right now. The current
            version above is read directly from the contract.
          </p>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Build status</h2>
        {history && history.nodes.length > 0 ? (
          <>
            <ul className="border-border divide-border divide-y rounded-lg border text-[13px]">
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
                  </span>
                  <span className="text-muted-foreground text-[12px]">
                    <span className="text-foreground font-medium">{node.status}</span>{" "}
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

      <section className="border-border grid gap-4 rounded-lg border px-5 py-4 text-[13px] sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <h2 className="font-semibold">What this proves</h2>
          <ul className="text-muted-foreground list-disc space-y-1 pl-4">
            <li>The owner&apos;s wallet signed this exact hash at the time shown.</li>
            <li>A copy that matches has not changed by a single byte since.</li>
            <li>Each build status was recorded by the owner, in order.</li>
          </ul>
        </div>
        <div className="grid content-start gap-1.5">
          <h2 className="font-semibold">What it does not prove</h2>
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
          </ul>
        </div>
      </section>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
