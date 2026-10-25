import { SignerAddress } from "@/components/audit/signer-address";
import { StatusTag } from "@/components/ui/status-tag";
import { qditExplorerUrl, type QditReceipt, type QditReceipts } from "@/lib/integrations/qdit-receipts";
import { expertTxUrl } from "@/lib/stellar/config";

/**
 * The public audit page's qdit receipts (WP-3.1): for each heading signed
 * from a qdit milestone, what qdit's milestone_proof contract says now next
 * to what doqtri signed, with the transactions behind both. The data and
 * its states are in lib/integrations/qdit-receipts.ts; nothing here comes
 * from qdit's own database. The page renders this only when the loader
 * returned receipts, which it does only with NEXT_PUBLIC_QDIT_INTEGRATION=1.
 *
 * The wording follows CONTRACT.md section 12: the chain's record is compared
 * with the version `vV` the heading was signed against. A newer record is a
 * resubmission and is shown as such; an older or missing one is an explicit
 * unverified state naming the mismatch; and a Verified heading is shown as
 * approved only when the chain says Approved at `vV` itself.
 */

const LINK = "text-primary underline-offset-2 hover:underline";
const NETWORK_LABEL = { testnet: "Testnet", mainnet: "Mainnet" } as const;

/** How the chain's record stands to the version the heading was signed against. */
function relation(receipt: QditReceipt): "same" | "newer" | "older" | "missing" | null {
  const { check, ref } = receipt;
  if (check.state === "unreachable" || !ref) return null;
  if (!check.chain) return "missing";
  if (check.chain.version === ref.version) return "same";
  return check.chain.version > ref.version ? "newer" : "older";
}

function stateTag(receipt: QditReceipt) {
  const { check } = receipt;
  if (check.state === "unreachable") return <StatusTag tone="planned">Not checked</StatusTag>;
  if (check.state === "differs") {
    const rel = relation(receipt);
    if (rel === "older" || rel === "missing") return <StatusTag tone="warning">Unverified</StatusTag>;
    if (rel === "newer") return <StatusTag tone="warning">Newer submission</StatusTag>;
    return <StatusTag tone="warning">Differs from the chain</StatusTag>;
  }
  return check.chain?.status === "Approved" ? (
    <StatusTag tone="onchain">Approved on chain</StatusTag>
  ) : (
    <StatusTag tone="verified">Matches the chain</StatusTag>
  );
}

function ChainLine({ receipt }: { receipt: QditReceipt }) {
  const { check, ref, record } = receipt;
  const network = ref ? NETWORK_LABEL[ref.network] : null;
  if (check.state === "unreachable") {
    const text = {
      rpc: `qdit's contract on ${network} could not be read just now. This says nothing about the milestone; try again in a moment.`,
      contract: "The contract this record names could not be read as qdit's milestone_proof.",
      invalid_ref:
        "This record's artifact_ref does not follow the qdit grammar (integration contract, section 10), so it cannot be checked.",
    }[check.reason];
    return <span data-testid="receipt-unreachable">{text}</span>;
  }
  const verified = record.status === "Verified";
  const ledger = check.ledger.toLocaleString("en-US");
  const signedAt = ref ? `v${ref.version}` : "the version it names";
  if (!check.chain) {
    return (
      <span data-testid="receipt-mismatch">
        Unverified: qdit&apos;s contract on {network} has no record of this milestone (as of ledger {ledger}), though
        this heading was signed against {signedAt}, so it cannot be checked.
        {verified ? " This heading is not shown as approved." : null}
      </span>
    );
  }
  const says = (
    <>
      <strong className="text-foreground">{check.chain.status}</strong> at v{check.chain.version}
    </>
  );
  const rel = relation(receipt);
  if (rel === "older") {
    return (
      <span data-testid="receipt-mismatch">
        Unverified: qdit&apos;s contract on {network} holds v{check.chain.version} ({check.chain.status}) as of ledger{" "}
        {ledger}, older than {signedAt}, the version this heading was signed against, so it cannot be checked.
        {verified ? " This heading is not shown as approved." : null}
      </span>
    );
  }
  if (rel === "newer") {
    return (
      <span data-testid="receipt-newer">
        {verified ? "Signed as Verified; the chain now says " : "qdit's contract now says "}
        {says} on {network}, as of ledger {ledger}: a newer submission than {signedAt}, the version this heading&apos;s
        signature refers to. What happened to {signedAt} is only in the contract&apos;s history.
        {verified ? " This heading is not shown as approved." : null}
      </span>
    );
  }
  if (check.state === "differs" && verified) {
    return (
      <span>
        Signed as Verified; the chain now says {says} on {network}, as of ledger {ledger}, so this heading is not shown
        as approved.
      </span>
    );
  }
  return (
    <span>
      qdit&apos;s contract on {network} says {says}, as of ledger {ledger}.
    </span>
  );
}

function ApprovalLine({ receipt }: { receipt: QditReceipt }) {
  const { check, ref, approvalTxHash } = receipt;
  if (!ref || check.state === "unreachable" || check.chain?.status !== "Approved") return null;
  // An approval of another version than the signed one is named as such.
  const of = check.chain.version === ref.version ? "" : ` of v${check.chain.version}`;
  if (approvalTxHash) {
    return (
      <span>
        <a className={LINK} href={qditExplorerUrl(ref.network, "tx", approvalTxHash)} target="_blank" rel="noreferrer">
          Approval transaction{of} →
        </a>
      </span>
    );
  }
  return (
    <span data-testid="approval-unrecorded">
      Doqtri has no record of the approval transaction{of}: it may be older than Stellar RPC&apos;s event window (about
      a week), or Doqtri did not see it in time. The{" "}
      <a className={LINK} href={qditExplorerUrl(ref.network, "contract", ref.contractId)} target="_blank" rel="noreferrer">
        contract&apos;s history on Stellar Expert
      </a>{" "}
      lists it.
    </span>
  );
}

function Receipt({ receipt, label }: { receipt: QditReceipt; label: string | undefined }) {
  const { record, ref, signing } = receipt;
  return (
    <li data-testid="qdit-receipt" data-state={receipt.check.state} className="grid gap-1.5 px-4 py-3">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate">{label ?? <span className="font-mono">{receipt.nodeId}</span>}</span>
        {stateTag(receipt)}
      </span>
      <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        Doqtri recorded <StatusTag tone="planned">{record.status}</StatusTag>
        {ref ? ` against milestone v${ref.version}` : null}
        {signing ? (
          <>
            {signing.signer ? (
              <span className="inline-flex items-center gap-1">
                · signed by <SignerAddress address={signing.signer} owner={signing.signerFrom === "owner"} />
              </span>
            ) : null}
            <a className={LINK} href={expertTxUrl(signing.txHash)} target="_blank" rel="noreferrer">
              signing transaction →
            </a>
          </>
        ) : (
          <span>· its transaction was not in the history read just now</span>
        )}
      </span>
      <span className="text-muted-foreground grid gap-1 text-[12px]">
        <ChainLine receipt={receipt} />
        <ApprovalLine receipt={receipt} />
        <span className="font-mono break-all">
          {record.artifactRef}
          {ref ? (
            <>
              {" · "}
              <a className={LINK} href={qditExplorerUrl(ref.network, "contract", ref.contractId)} target="_blank" rel="noreferrer">
                contract →
              </a>
            </>
          ) : null}
          {receipt.qditPageUrl ? (
            <>
              {" · "}
              <a className={LINK} href={receipt.qditPageUrl} target="_blank" rel="noreferrer" data-testid="qdit-page">
                milestone on qdit →
              </a>
            </>
          ) : null}
        </span>
      </span>
    </li>
  );
}

export function QditReceiptsSection({
  receipts,
  labels,
}: {
  receipts: QditReceipts;
  labels: Map<string, string> | null;
}) {
  return (
    <section className="grid gap-3" data-testid="qdit-receipts">
      <h2 className="text-xl font-extrabold tracking-[-0.03em]">qdit receipts</h2>
      <p className="text-muted-foreground text-[14px]">
        Headings signed from a qdit milestone, checked against qdit&apos;s milestone_proof contract on Stellar in the
        last 30 seconds. Nothing here is read from qdit itself.
      </p>
      {receipts.receipts.length > 0 ? (
        <ul className="glass divide-y divide-[var(--glass-lo)] rounded-2xl text-[13px]">
          {receipts.receipts.map((receipt) => (
            <Receipt key={receipt.nodeId} receipt={receipt} label={labels?.get(receipt.nodeId)} />
          ))}
        </ul>
      ) : null}
      {receipts.more > 0 ? (
        <p data-testid="receipts-more" className="text-muted-foreground text-[12px]">
          {receipts.more} more {receipts.more === 1 ? "heading was" : "headings were"} signed from qdit and{" "}
          {receipts.more === 1 ? "is" : "are"} not checked here. Each is listed under Build status with its
          artifact_ref, which anyone can check against the contract the same way.
        </p>
      ) : null}
    </section>
  );
}
