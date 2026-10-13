"use client";

import { useState } from "react";
import { Loader2Icon, StoreIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWallet } from "@/components/vault/wallet-provider";
import { TEMPLATE_CATEGORIES, type TemplateCategory } from "@/lib/templates";
import { MAX_TEMPLATE_DESCRIPTION, MAX_TEMPLATE_TITLE } from "@/lib/market";
import { MARKET_TOKENS } from "@/lib/stellar/market-config";
import { TemplateMarket } from "@/lib/stellar/market-client";
import { expertTxUrl, IS_MAINNET } from "@/lib/stellar/config";

/** What /api/market/publish prepared: the exact values `list_template` must carry. */
type Draft = {
  templateId: string;
  contentHash: string;
  token: string;
  price: string;
  parent: { id: string; title: string } | null;
  wallet: string;
};

type Step = "saving" | "preparing" | "signing" | "confirming" | null;

const STEP_LABELS: Record<Exclude<Step, null>, string> = {
  saving: "Saving…",
  preparing: "Preparing…",
  signing: "Sign in wallet…",
  confirming: "Confirming…",
};

const XLM = MARKET_TOKENS.find((t) => t.code === "XLM")!;

const field =
  "text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-9 rounded-[10px] border border-[var(--glass-lo)] bg-[var(--glass)] px-2.5 text-[13px] shadow-[inset_0_1px_0_0_var(--glass-hi)] outline-none focus-visible:ring-3";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Publishes a note as a free community template (progress/004, phase 1).
 *
 * Two steps, so the user sees what they sign before the wallet opens:
 * 1. Details → save the note, then /api/market/publish freezes it into a
 *    snapshot and returns its id and hash (and its parent, if the note was
 *    made from a community template).
 * 2. Publish on-chain → `list_template` with exactly those values, then
 *    /api/market/publish/confirm checks the ledger before the gallery shows it.
 *
 * Mount it with a `key` per note, so each opening starts from that note.
 */
export function PublishTemplateDialog({
  open,
  onOpenChange,
  docId,
  title: noteTitle,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string;
  title: string;
  /** Saves the note now, so the snapshot is what the editor shows. */
  onSave: () => Promise<string>;
}) {
  const wallet = useWallet();
  const [title, setTitle] = useState(noteTitle.slice(0, MAX_TEMPLATE_TITLE));
  const [category, setCategory] = useState<TemplateCategory>("Planning");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [step, setStep] = useState<Step>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = step !== null;

  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setError(null);
    try {
      setStep("saving");
      await onSave();
      setStep("preparing");
      const res = await fetch("/api/market/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          noteId: docId,
          title: title.trim(),
          category,
          description: description.trim(),
          price: "0",
          token: XLM.contract,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Draft> & { error?: string };
      if (!res.ok || !body.templateId) throw new Error(body.error || "The template could not be prepared.");
      setDraft(body as Draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The template could not be prepared.");
    } finally {
      setStep(null);
    }
  }

  /** The ledger can lag the submission by a ledger or two: retry "not on-chain yet". */
  async function confirmListing(templateId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch("/api/market/publish/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      if (res.ok) return;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const notYet = res.status === 409 && /isn't on-chain yet/.test(body.error ?? "");
      if (!notYet || attempt >= 3) throw new Error(body.error || "The listing could not be confirmed.");
      await sleep(2000);
    }
  }

  async function publish() {
    if (!draft || busy) return;
    setError(null);
    try {
      setStep("signing");
      const address = await wallet.ensureWallet();
      if (address !== draft.wallet) {
        throw new Error(
          "The connected wallet isn't the one this template was prepared for. Switch back to the wallet you signed in with.",
        );
      }
      const { txHash } = await TemplateMarket.listTemplate(address, {
        templateId: draft.templateId,
        contentHash: draft.contentHash,
        token: draft.token,
        price: BigInt(draft.price),
        parent: draft.parent?.id ?? null,
      });
      setStep("confirming");
      await confirmListing(draft.templateId);
      toast.success(`Published “${title.trim()}” to Community templates`, {
        action: { label: "View tx", onClick: () => window.open(expertTxUrl(txHash), "_blank", "noopener,noreferrer") },
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The template could not be published.");
    } finally {
      setStep(null);
      void wallet.refreshBalance();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[480px]" data-testid="publish-template-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StoreIcon className="text-foreground size-4" strokeWidth={1.5} />
            Publish as template
          </DialogTitle>
          <DialogDescription>
            Anyone on Doqtri can start a note from it. The template&apos;s hash and your wallet are recorded on Stellar,
            proving you published it first.
          </DialogDescription>
        </DialogHeader>

        {!draft ? (
          <form onSubmit={prepare} className="grid gap-3">
            <label className="text-muted-foreground grid gap-1 text-[12px]">
              Title
              <Input
                value={title}
                maxLength={MAX_TEMPLATE_TITLE}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
                required
              />
            </label>
            <label className="text-muted-foreground grid gap-1 text-[12px]">
              Category
              <select
                className={field}
                value={category}
                onChange={(e) => setCategory(e.target.value as TemplateCategory)}
                disabled={busy}
              >
                {TEMPLATE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-muted-foreground grid gap-1 text-[12px]">
              <span className="flex justify-between">
                Description
                <span className="tabular-nums">
                  {description.length}/{MAX_TEMPLATE_DESCRIPTION}
                </span>
              </span>
              <Textarea
                value={description}
                maxLength={MAX_TEMPLATE_DESCRIPTION}
                onChange={(e) => setDescription(e.target.value)}
                disabled={busy}
                placeholder="What is this template for?"
                className="text-[13px]"
              />
            </label>
            <div className="text-muted-foreground grid gap-0.5 text-[12px]">
              Price
              <span className="text-foreground">Free</span>
              <span className="text-label text-[11px]">Paid templates are coming soon.</span>
            </div>
            {error ? (
              <p role="alert" className="text-destructive text-[12px]">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !title.trim()} data-testid="publish-template-continue">
                {busy ? <Loader2Icon className="animate-spin" /> : null}
                {step ? STEP_LABELS[step] : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-3 text-[12px]">
            <dl className="glass grid gap-1.5 rounded-xl px-3 py-2.5">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Template</dt>
                <dd className="text-foreground truncate">{title.trim()}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Price</dt>
                <dd className="text-foreground">Free</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Content hash</dt>
                <dd className="text-foreground font-mono">
                  {draft.contentHash.slice(0, 8)}…{draft.contentHash.slice(-8)}
                </dd>
              </div>
            </dl>
            {draft.parent ? (
              <p className="glass rounded-xl px-3 py-2" data-testid="publish-parent-notice">
                Derived from “{draft.parent.title}”. Its creator earns 5% of each sale of this template.
              </p>
            ) : null}
            <p className="text-muted-foreground text-[11px]">
              {IS_MAINNET
                ? "Listing pays a one-time network fee from your wallet."
                : "Listing costs about 0.5 XLM in network fees on testnet, paid from your wallet."}{" "}
              The snapshot is frozen: later edits to the note don&apos;t change the template.
            </p>
            {error ? (
              <p role="alert" className="text-destructive text-[12px]">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={busy} onClick={() => void publish()} data-testid="publish-template-sign">
                {busy ? <Loader2Icon className="animate-spin" /> : null}
                {step ? STEP_LABELS[step] : "Publish on-chain"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
