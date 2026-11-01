import { CircleCheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { StatusTag } from "@/components/ui/status-tag";
import { shortHash } from "@/components/vault/version-history";
import { expertTxUrl } from "@/lib/stellar/config";
import type { WriteReceipt } from "@/lib/stellar/contract-client";

/*
 * The ship panel's card for the write it just made. A paid write the relay
 * answered 202 for (DOQ-5) is not a failure: the network took it but no
 * ledger had it yet, so the card says "sent" with a Pending badge and no
 * version, which the write doesn't have until it lands.
 */

export type Receipt = WriteReceipt & {
  kind: "register" | "update" | "node" | "done";
  contentHash?: string;
  nodeId?: string;
};

/** What a write the relay took but no ledger has confirmed yet says. */
export const PENDING_TOAST = "Sent. The network hasn't confirmed it yet, so it shows as pending until it does.";

/** A confirmed write's toast, or the pending one: a 202 is not a failure. */
export function announceWrite(receipt: WriteReceipt, confirmed: string) {
  if (receipt.pending) toast.info(PENDING_TOAST);
  else toast.success(confirmed);
}

function receiptLabel(receipt: Receipt): string {
  switch (receipt.kind) {
    case "register":
      return "Registered";
    case "update":
      return "Updated";
    case "done":
      return "Marked done";
    case "node":
      return `Node “${receipt.nodeId}” synced`;
  }
}

export function ReceiptCard({ receipt, onCopyHash }: { receipt: Receipt; onCopyHash: (hash: string) => void }) {
  const label = receiptLabel(receipt);
  return (
    <div className="glass grid gap-1 rounded-xl px-2.5 py-2 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          {receipt.pending ? null : <CircleCheckIcon className="text-success size-3.5" strokeWidth={2} aria-hidden />}
          {receipt.pending ? `${label}: sent` : label}
        </span>
        {receipt.pending ? (
          <StatusTag tone="warning" data-testid="receipt-pending" title="Sent; waiting for a ledger to confirm it">
            Pending
          </StatusTag>
        ) : receipt.version != null ? (
          <span className="text-muted-foreground font-mono">v{receipt.version}</span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 font-mono">
        <a
          className="text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
          href={expertTxUrl(receipt.txHash)}
          target="_blank"
          rel="noreferrer"
        >
          tx {shortHash(receipt.txHash)} →
        </a>
        <button
          type="button"
          aria-label="Copy transaction hash"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onCopyHash(receipt.txHash)}
        >
          <CopyIcon className="size-3" />
        </button>
      </div>
      {receipt.contentHash ? (
        <div className="text-muted-foreground truncate font-mono" title={receipt.contentHash}>
          sha256 {shortHash(receipt.contentHash)}
        </div>
      ) : null}
    </div>
  );
}
