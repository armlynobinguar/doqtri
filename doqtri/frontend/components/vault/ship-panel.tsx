"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AnchorIcon,
  CircleCheckIcon,
  FlagIcon,
  CopyIcon,
  DownloadIcon,
  LinkIcon,
  Loader2Icon,
  RefreshCwIcon,
  StoreIcon,
} from "lucide-react";
import { toast } from "sonner";
import { MAX_USER_FEE_STROOPS, USER_PAYS_FEES } from "@/lib/stellar/smart-wallet-config";
import { formatXlm } from "@/lib/stellar/wallet-balance";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusTag } from "@/components/ui/status-tag";
import {
  DoqtriRegistry,
  type ChainDocument,
  type ChainNode,
  type WriteReceipt,
} from "@/lib/stellar/contract-client";
import { expertTxUrl, REGISTRY_EDITORS } from "@/lib/stellar/config";
import { sha256Hex } from "@/lib/stellar/hash";
import { DoqtriError } from "@/lib/stellar/errors";
import { getDocumentHistory, type DocumentHistory } from "@/lib/stellar/history";
import { loadNoteSigner, NOTE_SIGNING_NOTICE, noteSigningRefusal, type NoteSigner } from "@/lib/stellar/note-signing";
import { loadWriteTarget, reportWorkspaceAssignment } from "@/lib/stellar/write-target";
import { NODE_STATUSES, type NodeStatus } from "@/lib/stellar/types";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useWallet } from "@/components/vault/wallet-provider";
import { GitHubLinks } from "@/components/vault/github-links";
import { IS_MAINNET, MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { PublishTemplateDialog } from "@/components/vault/publish-template-dialog";
import { buildMindmap } from "@/lib/mindmap";

type Props = {
  docId: string;
  title: string;
  markdown: string;
  /** Saves the note now and resolves with the exact text stored. */
  onSave: () => Promise<string>;
};

type Receipt = WriteReceipt & {
  kind: "register" | "update" | "node" | "done";
  contentHash?: string;
  nodeId?: string;
};

/**
 * "Mark mindmap done" sets the mindmap's root node to Verified with this tool,
 * and the anchored version it confirms as the artifact (e.g. "v3"), in the
 * same registry `anchor` call that anchors the text: one transaction.
 */
const DONE_NODE = "root";
const DONE_TOOL = "doqtri-done";
const doneRef = (version: number) => `v${version}`;

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

export function ShipPanel({ docId, title, markdown, onSave }: Props) {
  const [chainDoc, setChainDoc] = useState<ChainDocument | null>(null);
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [history, setHistory] = useState<DocumentHistory | null>(null);
  const [busy, setBusy] = useState(false);
  // Which half of Save & anchor is running, for the button label.
  const [anchorStep, setAnchorStep] = useState<"saving" | "signing" | null>(null);
  // Which step of Mark mindmap done is running, for the button label.
  const [doneStep, setDoneStep] = useState<"saving" | "anchoring" | null>(null);
  // The root node's on-chain record: says which version was marked done.
  const [rootNode, setRootNode] = useState<ChainNode | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [nodeId, setNodeId] = useState("root");
  const [status, setStatus] = useState<NodeStatus>("Planned");
  const [tool, setTool] = useState("");
  const [artifact, setArtifact] = useState("");
  // null until loaded; undefined when the column is unavailable.
  const [publishHeadings, setPublishHeadings] = useState<boolean | null | undefined>(null);
  // Only admins and owners of the note's workspace may change it (D-40); the
  // database enforces that, this only keeps the checkbox honest.
  const [canPublishHeadings, setCanPublishHeadings] = useState(false);
  // The user's standing on a note, keyed by the note it was read for; null
  // when it couldn't be read (the buttons stay and the relay decides).
  const [loadedSigner, setLoadedSigner] = useState<{ docId: string; signer: NoteSigner | null } | null>(null);

  const wallet = useWallet();
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [funding, setFunding] = useState(false);
  const unfunded = wallet.balance?.funded === false;
  // Email accounts sign with a passkey wallet; until they create one there is
  // nothing to sign with.
  const smartWallet = wallet.identity.kind === "email" ? wallet.identity.smartWallet : null;
  const noWallet = wallet.sessionAddress === null && smartWallet === null;
  const [creatingWallet, setCreatingWallet] = useState(false);
  const [addingPasskey, setAddingPasskey] = useState(false);
  // Once something is anchored, losing the only passkey would lock it.
  const needsBackup = smartWallet !== null && smartWallet.passkeys.length < 2;
  // Where users pay their own fees, a wallet below the most one write can cost
  // can't anchor until it's topped up.
  const paysOwnFees = USER_PAYS_FEES && smartWallet !== null;
  const preparing = wallet.preparingWallet;
  const lowBalance =
    paysOwnFees && !preparing && wallet.walletXlm !== null && wallet.walletXlm < MAX_USER_FEE_STROOPS;
  const [toppingUp, setToppingUp] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  async function topUp() {
    setToppingUp(true);
    try {
      await wallet.topUp();
      toast.success("Wallet topped up with test XLM");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The top-up failed. Try again.");
    } finally {
      setToppingUp(false);
    }
  }

  async function addBackupPasskey() {
    setAddingPasskey(true);
    try {
      await wallet.addPasskey();
      toast.success("Backup passkey added");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The passkey could not be added.");
    } finally {
      setAddingPasskey(false);
    }
  }

  async function createSmartWallet() {
    setCreatingWallet(true);
    try {
      await wallet.createSmartWallet();
      toast.success("Passkey wallet created");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Your wallet could not be created.");
    } finally {
      setCreatingWallet(false);
    }
  }

  // Undefined while this note's is loading. Writes the relay would refuse are
  // hidden, not offered (D-43, D-44).
  const signer = loadedSigner?.docId === docId ? loadedSigner.signer : undefined;
  const signingRefusal = signer ? noteSigningRefusal(signer, REGISTRY_EDITORS) : null;
  const canSign = signingRefusal === null;
  const signerLoading = signer === undefined;

  const tree = buildMindmap(title, markdown);
  const flatNodes = flattenNodes(tree);
  const chainVersion = chainDoc?.version ?? null;
  const unanchored =
    chainDoc != null && localHash != null && localHash !== chainDoc.contentHash;
  // The contract bumps the version even for an unchanged hash, so re-anchoring
  // identical text would spend a fee on nothing.
  const upToDate = chainDoc != null && !unanchored;
  // This exact version was confirmed done.
  const markedDone =
    upToDate &&
    chainVersion != null &&
    rootNode?.status === "Verified" &&
    rootNode.tool === DONE_TOOL &&
    rootNode.artifactRef === doneRef(chainVersion);

  const refreshChain = useCallback(async () => {
    const doc = await DoqtriRegistry.getDocument(docId);
    setChainDoc(doc);
    if (!doc) {
      setHistory(null);
      setRootNode(null);
      return;
    }
    setRootNode(await DoqtriRegistry.getNode(docId, DONE_NODE).catch(() => null));
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
      const root = await DoqtriRegistry.getNode(docId, DONE_NODE).catch(() => null);
      if (cancelled) return;
      setRootNode(root);
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
        .select("publish_headings, workspace_id")
        .eq("id", docId)
        .maybeSingle();
      if (cancelled) return;
      setPublishHeadings(
        error || !data ? undefined : Boolean(data.publish_headings),
      );
      if (error || !data) return;
      const { data: isAdmin } = await supabase.rpc("is_workspace_member", {
        p_workspace_id: data.workspace_id,
        p_min_role: "admin",
      });
      if (!cancelled) setCanPublishHeadings(isAdmin === true);
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  useEffect(() => {
    let cancelled = false;
    loadNoteSigner(createSupabaseBrowserClient(), docId)
      .catch(() => null)
      .then((loaded) => {
        if (!cancelled) setLoadedSigner({ docId, signer: loaded });
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  async function withWallet<T>(fn: (address: string) => Promise<T>) {
    // Opens the wallet modal in place when disconnected, and refuses to sign
    // with an account other than the one that owns this vault.
    const address = await wallet.ensureWallet();
    return fn(address);
  }

  /** Funding problems stay on screen next to the buttons; the rest are toasts. */
  function reportError(e: unknown, fallback: string) {
    if (e instanceof DoqtriError && e.code === "NOT_FUNDED") {
      setFundingError(e.message);
      void wallet.refreshBalance();
      return;
    }
    toast.error(e instanceof Error ? e.message : fallback);
  }

  async function saveAndAnchor() {
    setBusy(true);
    setReceipt(null);
    setFundingError(null);
    try {
      // Save first and hash what was stored: anchoring text Supabase doesn't
      // hold would leave the audit page unable to match it.
      setAnchorStep("saving");
      const saved = await onSave();
      const contentHash = await sha256Hex(saved);
      if (chainDoc != null && contentHash === chainDoc.contentHash) {
        toast.success(`Saved — v${chainDoc.version} already anchors this text`);
        return;
      }
      const registering = chainVersion == null;
      setAnchorStep("signing");
      const result = await withWallet(async (address) => {
        const target = await loadWriteTarget(docId);
        if (registering) {
          return DoqtriRegistry.registerDocument(address, docId, contentHash, target);
        }
        return DoqtriRegistry.updateDocument(address, docId, contentHash, target);
      });
      reportWorkspaceAssignment(result);
      setReceipt({
        ...result,
        kind: registering ? "register" : "update",
        contentHash,
      });
      toast.success(
        registering
          ? `Saved & registered as v${result.version ?? 1}`
          : `Saved & updated to v${result.version ?? "?"}`,
      );
      await refreshChain();
      void wallet.refreshBalance();
    } catch (e) {
      reportError(e, "Save & anchor failed");
    } finally {
      setAnchorStep(null);
      setBusy(false);
    }
  }

  async function syncNode() {
    setBusy(true);
    setReceipt(null);
    setFundingError(null);
    try {
      if (chainVersion == null) {
        throw new DoqtriError("NOT_REGISTERED", "Anchor the document first");
      }
      const result = await withWallet(async (address) =>
        DoqtriRegistry.setNodeStatus(
          address,
          docId,
          nodeId,
          status,
          tool || "manual",
          artifact,
          await loadWriteTarget(docId),
        ),
      );
      reportWorkspaceAssignment(result);
      setReceipt({ ...result, kind: "node", nodeId, version: chainVersion });
      toast.success(`Node “${nodeId}” synced on-chain`);
      await refreshChain();
      void wallet.refreshBalance();
    } catch (e) {
      reportError(e, "Ship failed");
    } finally {
      setBusy(false);
    }
  }

  /**
   * One click for "this mindmap is finished": save, then one registry
   * `anchor` call that anchors the text (a new version only if it changed)
   * and marks the root node Verified for that version. One transaction, so
   * one signature.
   */
  async function markDone() {
    setBusy(true);
    setReceipt(null);
    setFundingError(null);
    try {
      setDoneStep("saving");
      const saved = await onSave();
      const contentHash = await sha256Hex(saved);
      const address = await wallet.ensureWallet();
      const target = await loadWriteTarget(docId);

      // The version this call will leave: the same one if the text is already
      // anchored, otherwise the next (v1 for a new document).
      const current = chainDoc?.version ?? null;
      const version =
        current != null && contentHash === chainDoc?.contentHash ? current : (current ?? 0) + 1;

      setDoneStep("anchoring");
      const anchored = await DoqtriRegistry.anchor(
        address,
        docId,
        contentHash,
        [{ nodeId: DONE_NODE, status: "Verified", tool: DONE_TOOL, artifactRef: doneRef(version) }],
        target,
      );
      reportWorkspaceAssignment(anchored);
      setReceipt({ ...anchored, kind: "done", version: anchored.version ?? version, contentHash });
      toast.success(`Mindmap marked done and anchored as v${version}`);
      await refreshChain();
      void wallet.refreshBalance();
    } catch (e) {
      reportError(e, "Mark done failed");
    } finally {
      setDoneStep(null);
      setBusy(false);
    }
  }

  async function fundAccount() {
    setFunding(true);
    try {
      await wallet.fund();
      setFundingError(null);
      toast.success("Funded with Friendbot");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Friendbot failed");
    } finally {
      setFunding(false);
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
      toast.error(
        error.code === "42501"
          ? "Only an admin of this workspace can change this"
          : "Could not update public page setting",
      );
    }
  }

  return (
    <div className="border-border flex flex-col gap-3 border-t px-3 py-3.5 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">Stellar proof</span>
        <VersionBadge version={chainVersion} unanchored={unanchored} />
      </div>

      {noWallet ? (
        <div
          data-testid="no-wallet-notice"
          className="glass text-muted-foreground grid gap-1.5 rounded-xl px-2.5 py-2 text-[11px]"
        >
          <span>
            Anchoring on Stellar needs a wallet. Create one with a passkey — your fingerprint,
            face, or device PIN. Doqtri covers the fees.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={creatingWallet}
            className="h-6 justify-self-start px-2 text-[11px] max-lg:h-9 max-lg:text-[12px]"
            onClick={() => void createSmartWallet()}
          >
            {creatingWallet ? <Loader2Icon className="animate-spin" /> : null}
            {creatingWallet ? "Creating wallet…" : "Create passkey wallet"}
          </Button>
        </div>
      ) : null}

      {preparing ? (
        <div
          role="status"
          data-testid="wallet-preparing-notice"
          className="glass text-muted-foreground flex items-center gap-2 rounded-xl px-2.5 py-2 text-[11px]"
        >
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          <span>
            {smartWallet
              ? "Getting your wallet ready: adding free test XLM for network fees. Usually about 10 seconds."
              : "Funding your testnet account with Friendbot so it can pay network fees…"}
          </span>
        </div>
      ) : null}

      {lowBalance ? (
        <div
          role="alert"
          data-testid="low-balance-notice"
          className="glass relative grid gap-1.5 rounded-xl py-2 pr-2.5 pl-6 text-[11px] before:absolute before:top-[13px] before:left-2.5 before:size-1.5 before:rounded-full before:bg-warning before:shadow-[0_0_6px_var(--warning)]"
        >
          <span>
            Your wallet has {formatXlm(wallet.walletXlm!)} XLM. Each write takes its network fee from the wallet, so
            it needs at least {formatXlm(MAX_USER_FEE_STROOPS)} XLM to anchor.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={toppingUp}
            className="h-6 justify-self-start px-2 text-[11px] max-lg:h-9 max-lg:text-[12px]"
            onClick={() => void topUp()}
          >
            {toppingUp ? <Loader2Icon className="animate-spin" /> : null}
            {toppingUp ? "Topping up…" : "Top up with test XLM"}
          </Button>
        </div>
      ) : null}

      {needsBackup && chainVersion != null ? (
        <div
          data-testid="backup-passkey-notice"
          className="glass relative grid gap-1.5 rounded-xl py-2 pr-2.5 pl-6 text-[11px] before:absolute before:top-[13px] before:left-2.5 before:size-1.5 before:rounded-full before:bg-warning before:shadow-[0_0_6px_var(--warning)]"
        >
          <span>
            This note is anchored with your only passkey. Add a backup on another device or a security key, so
            losing this one doesn&apos;t lock it.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={addingPasskey}
            className="h-6 justify-self-start px-2 text-[11px] max-lg:h-9 max-lg:text-[12px]"
            onClick={() => void addBackupPasskey()}
          >
            {addingPasskey ? <Loader2Icon className="animate-spin" /> : null}
            {addingPasskey ? "Adding passkey…" : "Add a backup passkey"}
          </Button>
        </div>
      ) : null}

      {!noWallet && !preparing && (fundingError || unfunded) ? (
        <div
          role="alert"
          data-testid="funding-warning"
          className="glass relative grid gap-1.5 rounded-xl py-2 pr-2.5 pl-6 text-[11px] before:absolute before:top-[13px] before:left-2.5 before:size-1.5 before:rounded-full before:bg-warning before:shadow-[0_0_6px_var(--warning)]"
        >
          <span>
            {fundingError ??
              "This wallet is not funded yet, so it cannot pay transaction fees."}
          </span>
          {!IS_MAINNET ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={funding}
              className="h-6 justify-self-start px-2 text-[11px] max-lg:h-9 max-lg:text-[12px]"
              onClick={() => void fundAccount()}
            >
              {funding ? <Loader2Icon className="animate-spin" /> : null}
              Fund with Friendbot
            </Button>
          ) : null}
        </div>
      ) : null}

      {markedDone ? (
        <div
          data-testid="marked-done"
          className="glass flex items-center gap-2 rounded-xl px-2.5 py-2 text-[12px] max-lg:text-[13px]"
        >
          <CircleCheckIcon className="text-success size-4 shrink-0" strokeWidth={2} aria-hidden />
          <span className="flex-1">
            Done · v{chainVersion}
            {rootNode?.updatedAt ? (
              <span className="text-muted-foreground"> · {new Date(rootNode.updatedAt * 1000).toLocaleDateString()}</span>
            ) : null}
          </span>
        </div>
      ) : canSign ? (
        <Button
          type="button"
          size="sm"
          data-testid="mark-done"
          disabled={busy || unfunded || noWallet || lowBalance || preparing || signerLoading}
          title="Save, anchor this version and record on Stellar that the mindmap is done"
          className="w-full max-lg:h-10"
          onClick={() => void markDone()}
        >
          {doneStep || preparing ? <Loader2Icon className="animate-spin" /> : <FlagIcon />}
          {doneStep === "saving"
            ? "Saving…"
            : doneStep === "anchoring"
              ? "Anchoring…"
              : preparing
                  ? "Wallet getting ready…"
                  : rootNode?.tool === DONE_TOOL
                    ? "Mark this version done"
                    : "Mark mindmap done"}
        </Button>
      ) : null}

      {signingRefusal ? (
        <p data-testid="signing-notice" className="glass text-muted-foreground rounded-xl px-2.5 py-2 text-[11px]">
          {NOTE_SIGNING_NOTICE[signingRefusal]}
        </p>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || unfunded || noWallet || lowBalance || preparing || upToDate || signerLoading}
          title={
            upToDate
              ? "This version of the note is already anchored"
              : preparing
                ? "Your wallet is almost ready"
                : undefined
          }
          className="w-full max-lg:h-10"
          onClick={() => void saveAndAnchor()}
        >
          {anchorStep || preparing ? <Loader2Icon className="animate-spin" /> : <AnchorIcon />}
          {anchorStep === "saving"
            ? "Saving…"
            : anchorStep === "signing"
              ? "Signing & confirming…"
              : preparing
                ? "Wallet getting ready…"
                : "Save & anchor"}
        </Button>
      )}
      {canSign && paysOwnFees && !lowBalance ? (
        <p className="text-muted-foreground text-[11px]" data-testid="fee-note">
          Each write pays its network fee from your wallet, never more than {formatXlm(MAX_USER_FEE_STROOPS)} XLM.
        </p>
      ) : null}

      {receipt ? <ReceiptCard receipt={receipt} /> : null}

      {chainVersion != null ? (
        <div className="flex gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 flex-1 px-2 text-[11px] max-lg:h-10 max-lg:text-[13px]"
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
            className="h-7 flex-1 px-2 text-[11px] max-lg:h-10 max-lg:text-[13px]"
            disabled={unanchored || localHash == null}
            title={
              unanchored
                ? "The note has changed since it was anchored. Save & anchor it first."
                : "Download the exact text whose hash is on-chain"
            }
            onClick={downloadAnchored}
          >
            <DownloadIcon />
            Anchored .md
          </Button>
        </div>
      ) : null}

      {MARKET_CONTRACT_ID ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={noWallet}
            title={noWallet ? "Create a passkey wallet first" : "Share this note as a community template"}
            className="h-7 w-full px-2 text-[11px] max-lg:h-10 max-lg:text-[13px]"
            data-testid="publish-template"
            onClick={() => setPublishOpen(true)}
          >
            <StoreIcon />
            Publish as template
          </Button>
          {publishOpen ? (
            <PublishTemplateDialog
              key={docId}
              open={publishOpen}
              onOpenChange={setPublishOpen}
              docId={docId}
              title={title}
              onSave={onSave}
            />
          ) : null}
        </>
      ) : null}

      {chainVersion != null && publishHeadings !== undefined ? (
        <label
          className="text-muted-foreground flex items-center gap-2 text-[11px]"
          title={canPublishHeadings ? undefined : "Only an admin of this workspace can change this"}
        >
          <input
            type="checkbox"
            className="accent-primary"
            checked={publishHeadings === true}
            disabled={publishHeadings === null || !canPublishHeadings}
            onChange={(e) => void togglePublishHeadings(e.target.checked)}
          />
          Show headings on public page
        </label>
      ) : null}

      {history && history.versions.length > 0 ? (
        <VersionHistory history={history} />
      ) : null}

      {canSign ? (
        <>
          <label className="text-muted-foreground grid gap-1">
            Node
            <Select
              value={nodeId}
              onValueChange={(next) => next && setNodeId(next as string)}
              items={Object.fromEntries(flatNodes.map((n) => [n.id, n.label]))}
            >
              <SelectTrigger aria-label="Node" className="h-8 text-[12px] max-lg:h-10 max-lg:text-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {flatNodes.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="text-muted-foreground grid gap-1">
            Status
            <Select value={status} onValueChange={(next) => next && setStatus(next as NodeStatus)}>
              <SelectTrigger aria-label="Status" className="h-8 text-[12px] max-lg:h-10 max-lg:text-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NODE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="text-muted-foreground grid gap-1">
            Tool
            <input
              className="text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 max-lg:h-10 max-lg:text-base rounded-[10px] border border-[var(--glass-lo)] bg-[var(--glass)] px-2.5 shadow-[inset_0_1px_0_0_var(--glass-hi)] outline-none focus-visible:ring-3"
              placeholder="n8n / Make / Retool"
              value={tool}
              onChange={(e) => setTool(e.target.value)}
            />
          </label>

          <label className="text-muted-foreground grid gap-1">
            Artifact
            <input
              className="text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-8 max-lg:h-10 max-lg:text-base rounded-[10px] border border-[var(--glass-lo)] bg-[var(--glass)] px-2.5 shadow-[inset_0_1px_0_0_var(--glass-hi)] outline-none focus-visible:ring-3"
              placeholder="wf_id or URL"
              value={artifact}
              onChange={(e) => setArtifact(e.target.value)}
            />
          </label>

          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || unfunded || noWallet || lowBalance || signerLoading}
            className="w-full max-lg:h-10"
            onClick={() => void syncNode()}
          >
            {busy && anchorStep === null ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Sync node status
          </Button>
        </>
      ) : null}

      <GitHubLinks
        key={docId}
        docId={docId}
        nodes={flatNodes}
        anchored={chainVersion != null}
        canSign={canSign}
        signerLoading={signerLoading}
        onSynced={() => void refreshChain()}
      />
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
    return <StatusTag tone="planned">local</StatusTag>;
  }
  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      <StatusTag tone="onchain" className="font-mono">
        v{version}
      </StatusTag>
      {unanchored ? (
        <StatusTag
          tone="warning"
          title="The note has changed since this version was anchored"
        >
          unanchored changes
        </StatusTag>
      ) : (
        <StatusTag tone="verified">anchored</StatusTag>
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
        : receipt.kind === "done"
          ? "Marked done"
          : `Node “${receipt.nodeId}” synced`;

  return (
    <div className="glass grid gap-1 rounded-xl px-2.5 py-2 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          <CircleCheckIcon className="text-success size-3.5" strokeWidth={2} aria-hidden />
          {label}
        </span>
        {receipt.version != null ? (
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
