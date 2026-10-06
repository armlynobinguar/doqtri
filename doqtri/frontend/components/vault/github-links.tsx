"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRightIcon, GitPullRequestIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import { useWallet } from "@/components/vault/wallet-provider";
import { DoqtriRegistry } from "@/lib/stellar/contract-client";
import { DoqtriError } from "@/lib/stellar/errors";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { formatRef, parseGitHubRef, refUrl } from "@/lib/github/refs";
import { isReadyToSync, type GitHubItem, type Suggestion } from "@/lib/github/status";

type Node = { id: string; label: string };

type LinkRow = { id: string; node_id: string; node_label: string; repo: string; number: number };

type CheckResult = {
  linkId: string;
  item?: GitHubItem;
  suggestion?: Suggestion;
  error?: string;
};

const TONE: Record<string, "planned" | "info" | "onchain" | "verified"> = {
  Planned: "planned",
  Building: "info",
  Built: "onchain",
  Verified: "verified",
};

/** The tool name written on-chain for statuses that came from GitHub. */
const TOOL = "github";

/**
 * GitHub links for one note's mindmap nodes, inside the ship panel.
 *
 * Each heading can point at one issue or pull request. "Check" asks
 * /api/github/status what that work looks like now and which status it
 * suggests; "Sync" signs every suggestion that moves a node forward. The
 * contract needs the owner's signature for each status change, so the browser
 * signs — one transaction per node until a batch call exists.
 */
export function GitHubLinks({
  docId,
  nodes,
  anchored,
  onSynced,
}: {
  docId: string;
  nodes: Node[];
  /** Whether the note is registered on-chain; node statuses need that first. */
  anchored: boolean;
  onSynced: () => void;
}) {
  const wallet = useWallet();
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});
  const [chain, setChain] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<"check" | "link" | "sync" | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [linkNode, setLinkNode] = useState("");
  const [refText, setRefText] = useState("");

  const labelOf = useCallback((id: string) => nodes.find((n) => n.id === id)?.label, [nodes]);

  const loadLinks = useCallback(async (): Promise<LinkRow[]> => {
    const { data, error } = await createSupabaseBrowserClient()
      .from("node_links")
      .select("id, node_id, node_label, repo, number")
      .eq("document_id", docId)
      .order("created_at");
    if (error) {
      toast.error("Could not load GitHub links");
      return [];
    }
    const rows = (data ?? []) as LinkRow[];
    setLinks(rows);
    return rows;
  }, [docId]);

  const readChain = useCallback(
    async (rows: LinkRow[]) => {
      if (!anchored || rows.length === 0) {
        setChain({});
        return;
      }
      const entries = await Promise.all(
        rows.map(async (r) => [r.node_id, (await DoqtriRegistry.getNode(docId, r.node_id))?.status ?? null] as const),
      );
      setChain(Object.fromEntries(entries));
    },
    [anchored, docId],
  );

  const check = useCallback(
    async (rows: LinkRow[]) => {
      if (rows.length === 0) {
        setChecks({});
        return;
      }
      setBusy("check");
      try {
        const [res] = await Promise.all([
          fetch("/api/github/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ docId }),
          }),
          readChain(rows),
        ]);
        const payload = (await res.json()) as { links?: CheckResult[]; error?: string };
        if (!res.ok || !payload.links) throw new Error(payload.error ?? "GitHub check failed");
        setChecks(Object.fromEntries(payload.links.map((l) => [l.linkId, l])));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "GitHub check failed");
      } finally {
        setBusy(null);
      }
    },
    [docId, readChain],
  );

  // The ship panel mounts one instance per note (keyed by docId), so state
  // starts empty for each note and only this load fills it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await loadLinks();
      if (!cancelled && rows.length > 0) await check(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadLinks, check]);

  const linkedIds = new Set(links.map((l) => l.node_id));
  const unlinked = nodes.filter((n) => !linkedIds.has(n.id));
  const selectedNode = unlinked.some((n) => n.id === linkNode) ? linkNode : unlinked[0]?.id ?? "";

  async function addLink() {
    const ref = parseGitHubRef(refText);
    if (!ref) {
      toast.error("Use owner/repo#12 or a GitHub issue or pull request URL");
      return;
    }
    if (!selectedNode) return;
    setBusy("link");
    try {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Your session expired. Reconnect your wallet.");
      const { error } = await supabase.from("node_links").insert({
        user_id: user.id,
        document_id: docId,
        node_id: selectedNode,
        node_label: labelOf(selectedNode) ?? "",
        repo: ref.repo,
        number: ref.number,
      });
      if (error) {
        throw new Error(error.code === "23505" ? "That heading already has a link" : error.message);
      }
      setRefText("");
      toast.success(`Linked to ${formatRef(ref)}`);
      await check(await loadLinks());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the link");
    } finally {
      setBusy((b) => (b === "link" ? null : b));
    }
  }

  async function removeLink(link: LinkRow) {
    const { error } = await createSupabaseBrowserClient().from("node_links").delete().eq("id", link.id);
    if (error) {
      toast.error("Could not remove the link");
      return;
    }
    await loadLinks();
  }

  /** Links whose heading moved since they were made; never synced. */
  const drifted = (l: LinkRow) => labelOf(l.node_id) !== l.node_label;

  const ready = links.filter((l) => {
    const s = checks[l.id]?.suggestion;
    return s != null && !drifted(l) && isReadyToSync(chain[l.node_id] ?? null, s);
  });

  async function syncReady() {
    if (!anchored || ready.length === 0) return;
    setBusy("sync");
    let done = 0;
    try {
      const address = await wallet.ensureWallet();
      for (const link of ready) {
        const s = checks[link.id]?.suggestion;
        if (!s || s.status == null) continue;
        setProgress(`Signing ${done + 1} of ${ready.length}…`);
        await DoqtriRegistry.setNodeStatus(address, docId, link.node_id, s.status, TOOL, s.artifactRef);
        done += 1;
        toast.success(`“${link.node_label}” → ${s.status}`);
      }
    } catch (e) {
      if (e instanceof DoqtriError && e.code === "NOT_FUNDED") void wallet.refreshBalance();
      const message = e instanceof Error ? e.message : "Sync failed";
      toast.error(done > 0 ? `${message} (${done} of ${ready.length} synced)` : message);
    } finally {
      setProgress(null);
      setBusy(null);
      if (done > 0) {
        onSynced();
        await readChain(links);
        void wallet.refreshBalance();
      }
    }
  }

  return (
    <section className="border-border grid gap-2 border-t pt-3">
      <div className="flex items-center justify-between">
        <span className="text-foreground flex items-center gap-1.5 font-medium">
          <GitPullRequestIcon className="size-3.5" />
          GitHub
        </span>
        {links.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px] max-lg:h-9 max-lg:px-2.5"
            disabled={busy != null}
            onClick={() => void check(links)}
          >
            {busy === "check" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Check
          </Button>
        ) : null}
      </div>

      {links.length === 0 ? (
        <p className="text-muted-foreground text-[11px] leading-snug">
          Link a heading to a GitHub issue or pull request. When the work merges and CI passes,
          Doqtri suggests moving the node forward for you to sign.
        </p>
      ) : (
        <ul className="grid gap-1.5">
          {links.map((link) => (
            <LinkItem
              key={link.id}
              link={link}
              result={checks[link.id]}
              chainStatus={chain[link.node_id] ?? null}
              drifted={drifted(link)}
              anchored={anchored}
              onRemove={() => void removeLink(link)}
            />
          ))}
        </ul>
      )}

      {unlinked.length > 0 ? (
        <div className="grid gap-1.5">
          <select
            aria-label="Heading to link"
            className="border-input bg-card text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 max-lg:h-10 max-lg:text-base rounded-md border px-2 outline-none focus-visible:ring-3"
            value={selectedNode}
            onChange={(e) => setLinkNode(e.target.value)}
          >
            {unlinked.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <input
              aria-label="GitHub issue or pull request"
              className="border-input bg-card text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 max-lg:h-10 max-lg:text-base min-w-0 flex-1 rounded-md border px-2 outline-none focus-visible:ring-3"
              placeholder="owner/repo#12 or PR URL"
              value={refText}
              onChange={(e) => setRefText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addLink();
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 max-lg:h-10"
              disabled={busy != null || !refText.trim()}
              onClick={() => void addLink()}
            >
              {busy === "link" ? <Loader2Icon className="animate-spin" /> : null}
              Link
            </Button>
          </div>
        </div>
      ) : null}

      {ready.length > 0 ? (
        <Button
          type="button"
          size="sm"
          className="w-full max-lg:h-10"
          disabled={!anchored || busy != null || wallet.balance?.funded === false}
          onClick={() => void syncReady()}
        >
          {busy === "sync" ? <Loader2Icon className="animate-spin" /> : null}
          {progress ?? `Sync ${ready.length} ready node${ready.length === 1 ? "" : "s"}`}
        </Button>
      ) : null}
      {ready.length > 1 ? (
        <p className="text-muted-foreground text-[11px]">Each node is a separate signature.</p>
      ) : null}
    </section>
  );
}

function LinkItem({
  link,
  result,
  chainStatus,
  drifted,
  anchored,
  onRemove,
}: {
  link: LinkRow;
  result: CheckResult | undefined;
  chainStatus: string | null;
  drifted: boolean;
  anchored: boolean;
  onRemove: () => void;
}) {
  const ref = { repo: link.repo, number: link.number };
  const s = result?.suggestion;
  const moving = s != null && isReadyToSync(chainStatus, s);

  return (
    <li className="border-border grid gap-1 rounded-md border px-2 py-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-foreground truncate text-[12px]" title={link.node_label}>
          {link.node_label || link.node_id}
        </span>
        <button
          type="button"
          aria-label={`Unlink ${formatRef(ref)}`}
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={onRemove}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <a
          href={result?.item?.url ?? refUrl(ref)}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground font-mono text-[11px] hover:underline"
        >
          {formatRef(ref)}
        </a>
        {anchored ? (
          <StatusTag tone={chainStatus ? TONE[chainStatus] ?? "planned" : "planned"}>
            {chainStatus ?? "Not set"}
          </StatusTag>
        ) : null}
        {moving && s?.status ? (
          <>
            <ArrowRightIcon className="text-muted-foreground size-3" />
            <StatusTag tone={s.warning ? "warning" : TONE[s.status]}>{s.status}</StatusTag>
          </>
        ) : null}
      </div>

      {result?.error ? (
        <p className="text-destructive text-[11px] leading-snug">{result.error}</p>
      ) : s ? (
        <p className={s.status != null && s.warning ? "text-warning text-[11px]" : "text-muted-foreground text-[11px]"}>
          {s.reason}
          {s.status != null && !moving ? " · already up to date" : ""}
        </p>
      ) : null}

      {drifted ? (
        <p className="text-warning text-[11px] leading-snug">
          The heading this was linked to has moved. Unlink and link it again before syncing.
        </p>
      ) : null}
    </li>
  );
}
