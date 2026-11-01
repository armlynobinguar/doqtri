import { StatusTag } from "@/components/ui/status-tag";
import { expertTxUrl } from "@/lib/stellar/config";
import type { DocumentHistory } from "@/lib/stellar/history";

/*
 * A note's on-chain version history in the ship panel. Versions come from
 * the ledger (lib/stellar/history.ts). A paid write the relay answered 202
 * for (DOQ-5) has no version until a ledger has it, so it is listed on top
 * with a Pending badge; once it lands it is read as a version like any
 * other and the badge is gone.
 */

export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-6)}`;
}

/** Whether there is anything to list: versions, or writes still pending. */
export function hasVersionHistory(history: DocumentHistory | null): history is DocumentHistory {
  return history != null && (history.versions.length > 0 || (history.pending?.length ?? 0) > 0);
}

export function VersionHistory({ history }: { history: DocumentHistory }) {
  const versions = [...history.versions].reverse();
  const pending = [...(history.pending ?? [])].reverse();
  return (
    <details className="text-[11px]">
      <summary className="text-muted-foreground cursor-pointer select-none">
        Version history ({history.versions.length}
        {pending.length ? `, ${pending.length} pending` : ""})
      </summary>
      <ol className="mt-1.5 grid gap-1">
        {pending.map((p) => (
          <li key={p.txHash} className="flex items-center justify-between gap-2 font-mono" data-testid="version-pending">
            <StatusTag tone="warning" title="Sent; waiting for a ledger to confirm it">
              Pending
            </StatusTag>
            <a
              className="text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
              href={expertTxUrl(p.txHash)}
              target="_blank"
              rel="noreferrer"
              title={p.createdAt ? `Sent ${new Date(p.createdAt).toLocaleString()}` : undefined}
            >
              tx →
            </a>
          </li>
        ))}
        {versions.map((v) => (
          <li key={v.txHash} className="flex items-center justify-between gap-2 font-mono">
            <span>v{v.version}</span>
            <span className="text-muted-foreground" title={v.contentHash}>
              {shortHash(v.contentHash)}
            </span>
            <a
              className="text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
              href={expertTxUrl(v.txHash)}
              target="_blank"
              rel="noreferrer"
              title={new Date(v.closedAt).toLocaleString()}
            >
              tx →
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}
