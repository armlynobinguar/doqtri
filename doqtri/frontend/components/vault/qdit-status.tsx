"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import { useWallet } from "@/components/vault/wallet-provider";
import { suggestQditStatus, type QditMilestoneStateRow, type QditSuggestion } from "@/lib/integrations/qdit-status";
import { buildMindmap, type MindmapNode } from "@/lib/mindmap";
import type { QditLinkRow } from "@/lib/node-links";
import { anchorBatches, planRollups, type NodeUpdate } from "@/lib/node-rollup";
import { DoqtriRegistry, type ChainNode, type WriteReceipt } from "@/lib/stellar/contract-client";
import { DoqtriError } from "@/lib/stellar/errors";
import { sha256Hex } from "@/lib/stellar/hash";
import { loadWriteTarget, reportWorkspaceAssignment } from "@/lib/stellar/write-target";

/**
 * Status sync for the ship panel's qdit links (WP-2.8). Shown only with
 * NEXT_PUBLIC_QDIT_INTEGRATION=1, inside qdit-links.tsx.
 *
 * When the panel opens it asks the server to re-check every linked
 * milestone (R-09): the server reads milestone_proof itself (D-04) and
 * answers what the chain says. A heading whose own record differs from that
 * gets a suggestion (the D-19 status, `tool = "qdit"`), which an editor who
 * may sign this note (D-14, D-43, D-44) signs with their own wallet through
 * the usual anchor path: save first, re-check with fresh reads, then one
 * registry `anchor` call for the heading and every parent heading that rolls
 * up from it (D-24), at most 32 nodes to a call (R-04). Viewers see the
 * suggestion and no button.
 */

const TONE: Record<string, "planned" | "info" | "onchain" | "verified"> = {
  Planned: "planned",
  Building: "info",
  Built: "onchain",
  Verified: "verified",
};

type StatusResponse = { states: Record<string, QditMilestoneStateRow>; errors: string[] };

async function recheck(docId: string, force: boolean): Promise<StatusResponse> {
  const res = await fetch(`/api/integrations/qdit/docs/${docId}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  const payload = (await res.json().catch(() => ({}))) as Partial<StatusResponse> & { error?: string };
  if (!res.ok || !payload.states) throw new Error(payload.error ?? "Could not check qdit milestones");
  return { states: payload.states, errors: payload.errors ?? [] };
}

function flatten(tree: MindmapNode): string[] {
  const ids: string[] = [];
  const walk = (n: MindmapNode) => {
    ids.push(n.id);
    n.children.forEach(walk);
  };
  walk(tree);
  return ids;
}

async function readRecords(docId: string, nodeIds: string[]): Promise<Record<string, ChainNode | null>> {
  const entries = await Promise.all(nodeIds.map(async (id) => [id, await DoqtriRegistry.getNode(docId, id)] as const));
  return Object.fromEntries(entries);
}

export type QditStatusSync = {
  suggestions: Record<string, QditSuggestion>;
  records: Record<string, ChainNode | null>;
  /** Link ids with something to sign. */
  ready: string[];
  checking: boolean;
  signing: boolean;
  /** The links being signed now. */
  signingIds: string[];
  /** A wallet is there and funded: the buttons can work. */
  walletReady: boolean;
  progress: string | null;
  check: () => Promise<void>;
  sign: (linkIds: string[]) => Promise<void>;
};

export function useQditStatusSync({
  docId,
  title,
  links,
  otherLinked,
  canSign,
  onSave,
  reloadLinks,
  onSynced,
}: {
  docId: string;
  title: string;
  links: QditLinkRow[];
  /** Headings linked by another provider: they carry their own status, never a roll-up. */
  otherLinked: string[];
  canSign: boolean;
  onSave: () => Promise<string>;
  /** Re-reads the note's qdit links (a save may move them) and answers them. */
  reloadLinks: () => Promise<QditLinkRow[]>;
  onSynced: () => void;
}): QditStatusSync {
  const wallet = useWallet();
  const [states, setStates] = useState<Record<string, QditMilestoneStateRow>>({});
  const [records, setRecords] = useState<Record<string, ChainNode | null>>({});
  const [checking, setChecking] = useState(false);
  const [signingIds, setSigningIds] = useState<string[]>([]);
  const signing = signingIds.length > 0;
  const [progress, setProgress] = useState<string | null>(null);

  const linkKey = links.map((l) => `${l.id}:${l.node_id}`).join(",");

  const check = useCallback(async () => {
    if (links.length === 0) return;
    setChecking(true);
    try {
      const [result, nodeRecords] = await Promise.all([
        recheck(docId, false),
        readRecords(
          docId,
          links.map((l) => l.node_id),
        ),
      ]);
      setStates(result.states);
      setRecords(nodeRecords);
      if (result.errors.length > 0) toast.warning(result.errors[0]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not check qdit milestones");
    } finally {
      setChecking(false);
    }
    // linkKey stands for `links`: re-check when a link is added, removed or moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, linkKey]);

  // When the panel opens, and when the links change.
  useEffect(() => {
    const timer = setTimeout(() => void check(), 0);
    return () => clearTimeout(timer);
  }, [check]);

  const suggestions = useMemo(
    () =>
      Object.fromEntries(
        links.map((l) => [
          l.id,
          suggestQditStatus({ link: l, state: states[l.qdit_milestone_id], record: records[l.node_id] ?? null }),
        ]),
      ),
    [links, states, records],
  );
  const ready = links.filter((l) => suggestions[l.id]?.kind === "sign").map((l) => l.id);

  async function sign(linkIds: string[]) {
    if (!canSign || linkIds.length === 0) return;
    setSigningIds(linkIds);
    let signed = 0;
    try {
      // The text the records are keyed against: save, and anchor exactly
      // that (the same text keeps its version), as Mark mindmap done does.
      setProgress("Saving…");
      const saved = await onSave();
      const contentHash = await sha256Hex(saved);
      setProgress("Checking Stellar…");
      const [fresh, rows] = await Promise.all([recheck(docId, true), reloadLinks()]);
      setStates(fresh.states);
      const tree = buildMindmap(title, saved);
      const allRecords = await readRecords(docId, flatten(tree));
      setRecords(allRecords);

      // The ids picked, re-found on the rows as the save left them.
      const updates: NodeUpdate[] = [];
      for (const row of rows.filter((r) => linkIds.includes(r.id))) {
        const s = suggestQditStatus({ link: row, state: fresh.states[row.qdit_milestone_id], record: allRecords[row.node_id] ?? null });
        if (s.kind === "sign") updates.push(s.update);
      }
      if (updates.length === 0) {
        toast.info("Nothing to sign: Stellar already says this.");
        return;
      }
      const rollups = planRollups({
        tree,
        records: allRecords,
        linked: [...rows.map((r) => r.node_id), ...otherLinked],
        pending: updates,
      }).updates;
      const batches = anchorBatches([...updates, ...rollups]);

      const address = await wallet.ensureWallet();
      const target = await loadWriteTarget(docId);
      let last: WriteReceipt | null = null;
      for (const [i, batch] of batches.entries()) {
        setProgress(batches.length > 1 ? `Signing ${i + 1} of ${batches.length}…` : "Signing…");
        last = await DoqtriRegistry.anchor(address, docId, contentHash, batch, target);
        signed += batch.length;
      }
      if (last) reportWorkspaceAssignment(last);
      const parents = rollups.length > 0 ? ` and ${rollups.length} parent heading${rollups.length === 1 ? "" : "s"}` : "";
      toast.success(
        updates.length === 1
          ? `Marked ${updates[0].status} on Stellar${parents}`
          : `Signed ${updates.length} headings${parents} on Stellar`,
      );
    } catch (e) {
      if (e instanceof DoqtriError && e.code === "NOT_FUNDED") void wallet.refreshBalance();
      toast.error(e instanceof Error ? e.message : "Signing failed");
    } finally {
      setProgress(null);
      setSigningIds([]);
      if (signed > 0) {
        onSynced();
        void wallet.refreshBalance();
        await check();
      }
    }
  }

  const walletReady =
    (wallet.sessionAddress !== null || (wallet.identity.kind === "email" && wallet.identity.smartWallet !== null)) &&
    wallet.balance?.funded !== false;

  return { suggestions, records, ready, checking, signing, signingIds, walletReady, progress, check, sign };
}

/** One linked heading's status line: what its record says, what Stellar says, and the button. */
export function QditStatusLine({
  suggestion,
  record,
  canSign,
  disabled,
  busy,
  onSign,
}: {
  suggestion: QditSuggestion | undefined;
  record: ChainNode | null | undefined;
  canSign: boolean;
  disabled: boolean;
  busy: boolean;
  onSign: () => void;
}) {
  if (!suggestion) return null;
  const now = record?.status ?? null;
  const next = suggestion.kind === "sign" ? suggestion.update.status : null;
  return (
    <div className="grid gap-1" data-testid="qdit-status">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusTag tone={now ? TONE[now] ?? "planned" : "planned"}>{now ?? "Not set"}</StatusTag>
        {next ? (
          <>
            <ArrowRightIcon className="text-muted-foreground size-3" />
            <StatusTag tone={TONE[next]}>{next}</StatusTag>
          </>
        ) : null}
      </div>
      <p className="text-muted-foreground text-[11px] leading-snug">
        {suggestion.reason}
        {suggestion.preview ? ` ${suggestion.preview}` : ""}
      </p>
      {next ? (
        canSign ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 justify-self-start px-2 text-[11px] max-lg:h-10 max-lg:text-[13px]"
            disabled={disabled}
            onClick={onSign}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : null}
            Mark {next}
          </Button>
        ) : (
          <p className="text-muted-foreground text-[11px]">Ready to mark {next}; someone who can sign this note marks it.</p>
        )
      ) : null}
    </div>
  );
}
