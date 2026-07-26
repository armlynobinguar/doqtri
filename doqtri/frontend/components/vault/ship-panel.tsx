"use client";

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DoqtriRegistry } from "@/lib/stellar/contract-client";
import { expertTxUrl } from "@/lib/stellar/config";
import { sha256Hex } from "@/lib/stellar/hash";
import { DoqtriError } from "@/lib/stellar/errors";
import { NODE_STATUSES, type NodeStatus } from "@/lib/stellar/types";
import { getWalletAddress } from "@/lib/wallet";
import { buildMindmap } from "@/lib/mindmap";

type Props = {
  docId: string;
  title: string;
  markdown: string;
};

export function ShipPanel({ docId, title, markdown }: Props) {
  const [chainVersion, setChainVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState("root");
  const [status, setStatus] = useState<NodeStatus>("Planned");
  const [tool, setTool] = useState("");
  const [artifact, setArtifact] = useState("");

  const tree = buildMindmap(title, markdown);
  const flatNodes = flattenNodes(tree);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const doc = await DoqtriRegistry.getDocument(docId);
      if (!cancelled) setChainVersion(doc?.version ?? null);
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
    setTxHash(null);
    try {
      const contentHash = await sha256Hex(markdown);
      const hash = await withWallet(async (address) => {
        if (chainVersion == null) {
          return DoqtriRegistry.registerDocument(address, docId, contentHash);
        }
        return DoqtriRegistry.updateDocument(address, docId, contentHash);
      });
      const onchain = await DoqtriRegistry.getDocument(docId);
      setChainVersion(onchain?.version ?? (chainVersion == null ? 1 : chainVersion + 1));
      setTxHash(hash);
      toast.success(
        chainVersion == null ? "Registered on Stellar" : `Updated to v${onchain?.version}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Anchor failed");
    } finally {
      setBusy(false);
    }
  }

  async function syncNode() {
    setBusy(true);
    setTxHash(null);
    try {
      if (chainVersion == null) {
        throw new DoqtriError("NOT_REGISTERED", "Anchor the document first");
      }
      const hash = await withWallet((address) =>
        DoqtriRegistry.setNodeStatus(
          address,
          docId,
          nodeId,
          status,
          tool || "manual",
          artifact,
        ),
      );
      setTxHash(hash);
      toast.success(`Node “${nodeId}” synced on-chain`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ship failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-border flex flex-col gap-2.5 border-t px-3 py-3 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground font-medium tracking-tight">
          Stellar proof
        </span>
        <span className="text-muted-foreground font-mono text-[11px]">
          {chainVersion == null ? "local" : `on-chain v${chainVersion}`}
        </span>
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

      {txHash ? (
        <a
          className="text-primary truncate underline-offset-2 hover:underline"
          href={expertTxUrl(txHash)}
          target="_blank"
          rel="noreferrer"
        >
          View transaction →
        </a>
      ) : null}
    </div>
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
