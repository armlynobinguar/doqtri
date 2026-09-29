"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyIcon, DownloadIcon, LinkIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DoqtriRegistry,
  type ChainDocument,
  type WriteReceipt,
} from "@/lib/stellar/contract-client";
import { expertTxUrl } from "@/lib/stellar/config";
import { sha256Hex } from "@/lib/stellar/hash";
import { DoqtriError } from "@/lib/stellar/errors";
import { getDocumentHistory, type DocumentHistory } from "@/lib/stellar/history";
import { NODE_STATUSES, type NodeStatus } from "@/lib/stellar/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { getWalletAddress } from "@/lib/wallet";
import { buildMindmap } from "@/lib/mindmap";

type Props = {
  docId: string;
  title: string;
  markdown: string;
};

type Receipt = WriteReceipt & {
  kind: "register" | "update" | "node";
  contentHash?: string;
  nodeId?: string;
};

function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-6)}`;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy ${what.toLowerCase()}`);
  }
}

export function ShipPanel({ docId, title, markdown }: Props) {
  const [chainDoc, setChainDoc] = useState<ChainDocument | null>(null);
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [history, setHistory] = useState<DocumentHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [nodeId, setNodeId] = useState("root");
  const [status, setStatus] = useState<NodeStatus>("Planned");
  const [tool, setTool] = useState("");
  const [artifact, setArtifact] = useState("");
  // null until loaded; undefined when the column is unavailable.
  const [publishHeadings, setPublishHeadings] = useState<boolean | null | undefined>(null);

  const tree = buildMindmap(title, markdown);
  const flatNodes = flattenNodes(tree);
  const chainVersion = chainDoc?.version ?? null;
  const unanchored =
    chainDoc != null && localHash != null && localHash !== chainDoc.contentHash;

  const refreshChain = useCallback(async () => {
    const doc = await DoqtriRegistry.getDocument(docId);
    setChainDoc(doc);
    if (!doc) {
      setHistory(null);
      return;
    }
    try {
      setHistory(await getDocumentHistory(docId));
    } catch {
      // History is supplementary; the badge still works from get_document.
      setHistory(null);
    }
  }, [docId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const doc = await DoqtriRegistry.getDocument(docId);
      if (cancelled) return;
      setChainDoc(doc);
      if (!doc) return;
      try {
        const loaded = await getDocumentHistory(docId);
        if (!cancelled) setHistory(loaded);
      } catch {
        if (!cancelled) setHistory(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // Hashing is cheap, but the editor fires on every keystroke.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void sha256Hex(markdown).then((hash) => {
        if (!cancelled) setLocalHash(hash);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [markdown]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("documents")
        .select("publish_headings")
        .eq("id", docId)
        .maybeSingle();
      if (cancelled) return;
      setPublishHeadings(
        error || !data ? undefined : Boolean(data.publish_headings),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  async function withWallet<T>(fn: (address: string) => Promise<T>) {
    const address = await getWalletAddress();
    if (!address) {
      throw new DoqtriError(
        "NO_WALLET",
        "Connect your Stellar wallet from the landing page first.",
      );
    }
    return fn(address);
  }

  async function anchor() {
    setBusy(true);
    setReceipt(null);
    try {
      const contentHash = await sha256Hex(markdown);
      const registering = chainVersion == null;
      const result = await withWallet(async (address) => {
        if (registering) {
          return DoqtriRegistry.registerDocument(address, docId, contentHash);
        }
        return DoqtriRegistry.updateDocument(address, docId, contentHash);
      });
      setReceipt({
        ...result,
        kind: registering ? "register" : "update",
        contentHash,
      });
      toast.success(
        registering
          ? "Registered on Stellar"
          : `Updated to v${result.version ?? "?"}`,
      );
      await refreshChain();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Anchor failed");
    } finally {
      setBusy(false);
    }
  }

  async function syncNode() {
    setBusy(true);
    setReceipt(null);
    try {
      if (chainVersion == null) {
        throw new DoqtriError("NOT_REGISTERED", "Anchor the document first");
      }
      const result = await withWallet((address) =>
        DoqtriRegistry.setNodeStatus(
          address,
          docId,
          nodeId,
          status,
          tool || "manual",
          artifact,
        ),
      );
      setReceipt({ ...result, kind: "node", nodeId, version: chainVersion });
      toast.success(`Node “${nodeId}” synced on-chain`);
      await refreshChain();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ship failed");
    } finally {
      setBusy(false);
    }
  }

  function downloadAnchored() {
    // The exact bytes sha256Hex hashed: a Blob encodes strings as UTF-8, no BOM.
    const blob = new Blob([markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title || docId}.v${chainVersion}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function togglePublishHeadings(next: boolean) {
    const previous = publishHeadings;
    setPublishHeadings(next);
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase
      .from("documents")
      .update({ publish_headings: next })
      .eq("id", docId);
    if (error) {
      setPublishHeadings(previous);
      toast.error("Could not update public page setting");
    }
  }

  return (
    <div className="border-border flex flex-col gap-2.5 border-t px-3 py-3 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground font-medium tracking-tight">
          Stellar proof
        </span>
        <VersionBadge version={chainVersion} unanchored={unanchored} />
      </div>

      <Button
        type="button"
        size="sm"
        disabled={busy}
        className="w-full"
        onClick={() => void anchor()}
      >
        {busy ? <Loader2Icon className="animate-spin" /> : null}
        {chainVersion == null ? "Register hash" : "Update hash"}
      </Button>

      {receipt ? <ReceiptCard receipt={receipt} /> : null}

      {chainVersion != null ? (
        <div className="flex gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 flex-1 px-2 text-[11px]"
            onClick={() =>
              void copy(`${window.location.origin}/d/${docId}`, "Audit link")
            }
          >
            <LinkIcon />
            Audit link
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 flex-1 px-2 text-[11px]"
            disabled={unanchored || localHash == null}
            title={
              unanchored
                ? "The note has changed since it was anchored. Update the hash first."
                : "Download the exact text whose hash is on-chain"
            }
            onClick={downloadAnchored}
          >
            <DownloadIcon />
            Anchored .md
          </Button>
        </div>
      ) : null}

      {chainVersion != null && publishHeadings !== undefined ? (
        <label className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            className="accent-primary"
            checked={publishHeadings === true}
            disabled={publishHeadings === null}
            onChange={(e) => void togglePublishHeadings(e.target.checked)}
          />
          Show headings on public page
        </label>
      ) : null}

      {history && history.versions.length > 0 ? (
        <VersionHistory history={history} />
      ) : null}

      <label className="text-muted-foreground grid gap-1">
        Node
        <select
          className="border-border bg-background h-8 rounded-md border px-2"
          value={nodeId}
          onChange={(e) => setNodeId(e.target.value)}
        >
          {flatNodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </label>

      <label className="text-muted-foreground grid gap-1">
        Status
        <select
          className="border-border bg-background h-8 rounded-md border px-2"
          value={status}
          onChange={(e) => setStatus(e.target.value as NodeStatus)}
        >
          {NODE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label className="text-muted-foreground grid gap-1">
        Tool
        <input
          className="border-border bg-background h-8 rounded-md border px-2"
          placeholder="n8n / Make / Retool"
          value={tool}
          onChange={(e) => setTool(e.target.value)}
        />
      </label>

      <label className="text-muted-foreground grid gap-1">
        Artifact
        <input
          className="border-border bg-background h-8 rounded-md border px-2"
          placeholder="wf_id or URL"
          value={artifact}
          onChange={(e) => setArtifact(e.target.value)}
        />
      </label>

      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={busy}
        className="w-full"
        onClick={() => void syncNode()}
      >
        {busy ? <Loader2Icon className="animate-spin" /> : null}
        Sync node status
      </Button>
    </div>
  );
}

function VersionBadge({
  version,
  unanchored,
}: {
  version: number | null;
  unanchored: boolean;
}) {
  if (version == null) {
    return (
      <span className="text-muted-foreground font-mono text-[11px]">local</span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px]">
      <span className="border-primary/40 text-primary rounded border px-1.5 py-px">
        v{version}
      </span>
      {unanchored ? (
        <span
          className="text-amber-500"
          title="The note has changed since this version was anchored"
        >
          unanchored changes
        </span>
      ) : (
        <span className="text-muted-foreground">anchored</span>
      )}
    </span>
  );
}

function ReceiptCard({ receipt }: { receipt: Receipt }) {
  const label =
    receipt.kind === "register"
      ? "Registered"
      : receipt.kind === "update"
        ? "Updated"
        : `Node “${receipt.nodeId}” synced`;

  return (
    <div className="border-border bg-background/60 grid gap-1 rounded-md border px-2 py-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        {receipt.version != null ? (
          <span className="text-muted-foreground font-mono">v{receipt.version}</span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 font-mono">
        <a
          className="text-primary underline-offset-2 hover:underline"
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
          onClick={() => void copy(receipt.txHash, "Transaction hash")}
        >
          <CopyIcon className="size-3" />
        </button>
      </div>
      {receipt.contentHash ? (
        <div
          className="text-muted-foreground truncate font-mono"
          title={receipt.contentHash}
        >
          sha256 {shortHash(receipt.contentHash)}
        </div>
      ) : null}
    </div>
  );
}

function VersionHistory({ history }: { history: DocumentHistory }) {
  const versions = [...history.versions].reverse();
  return (
    <details className="text-[11px]">
      <summary className="text-muted-foreground cursor-pointer select-none">
        Version history ({history.versions.length})
      </summary>
      <ol className="mt-1.5 grid gap-1">
        {versions.map((v) => (
          <li key={v.txHash} className="flex items-center justify-between gap-2 font-mono">
            <span>v{v.version}</span>
            <span className="text-muted-foreground" title={v.contentHash}>
              {shortHash(v.contentHash)}
            </span>
            <a
              className="text-primary underline-offset-2 hover:underline"
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

function flattenNodes(
  root: { id: string; label: string; children: { id: string; label: string; children: unknown[] }[] },
): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [{ id: root.id, label: root.label }];
  const walk = (nodes: typeof root.children) => {
    for (const n of nodes) {
      out.push({ id: n.id, label: n.label });
      walk(n.children as typeof root.children);
    }
  };
  walk(root.children);
  return out;
}
