import { StatusTag } from "@/components/ui/status-tag";
import { expertTxUrl } from "@/lib/stellar/config";
import { cn } from "@/lib/utils";

/*
 * The account page's "Recent on-chain activity" list. A passkey wallet's
 * entries come from chain_writes, where a paid write the relay answered 202
 * for is pending until the chain-jobs run settles it (DOQ-5): it shows a
 * Pending badge until then, and a failed one shows as failed.
 */

export type Activity = {
  hash: string;
  label: string;
  detail: string | null;
  at: string;
  ok: boolean;
  /** Sent, but no ledger had confirmed it when this was read. */
  pending?: boolean;
};

export const WRITE_LABELS: Record<string, string> = {
  register_document: "Registered a note",
  update_document: "Anchored a new version",
  anchor: "Anchored a note",
  set_node_status: "Synced a mindmap node",
  // Team notes (WP-1.4): written as a workspace editor.
  anchor_as: "Anchored a team note",
  update_document_as: "Anchored a new version of a team note",
  set_node_status_as: "Synced a team note's mindmap node",
  assign_document: "Shared a note with its workspace",
  unassign_document: "Took a note out of its workspace",
};

/** A chain_writes row as the list shows it; rows from before DOQ-5 carry no status and are confirmed. */
export function writeActivity(
  row: { tx_hash: string; fn: string; created_at: string; status?: string | null },
  title: string | null,
): Activity {
  const failed = row.status === "failed";
  const label = WRITE_LABELS[row.fn] ?? "Wrote on-chain";
  return {
    hash: row.tx_hash,
    label: failed ? `${label} (failed)` : label,
    detail: title,
    at: row.created_at,
    ok: !failed,
    ...(row.status === "pending" ? { pending: true } : {}),
  };
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ActivityList({ activity }: { activity: Activity[] }) {
  return (
    <ul className="divide-border -my-1 divide-y text-[13px]" data-testid="activity-list">
      {activity.map((a) => (
        <li key={a.hash} className="flex items-center gap-3 py-2">
          <span className="grid min-w-0 flex-1">
            <span className={cn(!a.ok && "text-warning")}>{a.label}</span>
            <span className="text-muted-foreground truncate text-[12px]">
              {a.detail ? `${a.detail} · ` : ""}
              {formatDate(a.at)}
            </span>
          </span>
          {a.pending ? (
            <StatusTag tone="warning" data-testid="activity-pending" title="Sent; waiting for a ledger to confirm it">
              Pending
            </StatusTag>
          ) : null}
          <a
            href={expertTxUrl(a.hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground font-mono text-[12px]"
          >
            {a.hash.slice(0, 6)}…{a.hash.slice(-4)}
          </a>
        </li>
      ))}
    </ul>
  );
}
