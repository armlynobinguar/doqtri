"use client";

import { useEffect, useState } from "react";
import {
  FilePlus2Icon,
  Loader2Icon,
  RefreshCwIcon,
  ShoppingBagIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWallet } from "@/components/vault/wallet-provider";
import { useActiveWorkspace } from "@/components/vault/workspace-context";
import { formatAmount, shortAddress, type CommunityTemplate } from "@/lib/market";
import { quoteBuy, TemplateMarket, type BuyQuote } from "@/lib/stellar/market-client";
import { expertTxUrl } from "@/lib/stellar/config";

type Step = "signing" | "copying" | null;

const STEP_LABELS: Record<Exclude<Step, null>, string> = {
  signing: "Sign in wallet…",
  copying: "Adding to your vault…",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirm-to-buy for a paid community template (progress/004, phase 2).
 *
 * Everything is priced before the wallet opens: the split, the network fee,
 * the buyer's balance and trustline, and a simulation of the buy itself.
 * The buy can't go ahead while any problem is listed. After it lands,
 * /api/market/claim checks `has_purchased` on-chain and copies the template
 * into the vault; the ledger can lag the submission, so a 402 is retried.
 */
export function BuyTemplateDialog({
  template,
  open,
  onOpenChange,
  onBought,
}: {
  template: CommunityTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBought: (note: { id: string; title: string }) => void;
}) {
  const wallet = useWallet();
  // The copy goes into the workspace on screen; a viewer there can't take
  // one (D-14), so they are stopped before paying, not after.
  const { active: workspace, canCreate } = useActiveWorkspace();
  const [quote, setQuote] = useState<BuyQuote | null>(null);
  // Mounted only while open (see CommunityPreview), so it starts quoting.
  const [quoting, setQuoting] = useState(true);
  const [step, setStep] = useState<Step>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = step !== null;

  const { ensureWallet } = wallet;
  // Bumped by Refresh (and after a failed copy) to quote again.
  const [quoteRun, setQuoteRun] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const address = await ensureWallet();
        const next = await quoteBuy(address, template.id);
        if (cancelled) return;
        setQuote(next);
      } catch (e) {
        if (cancelled) return;
        setQuote(null);
        setError(e instanceof Error ? e.message : "The price couldn't be checked.");
      } finally {
        if (!cancelled) setQuoting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureWallet, template.id, quoteRun]);

  function refresh() {
    setQuoting(true);
    setError(null);
    setQuoteRun((n) => n + 1);
  }

  async function claim(txHash: string | null): Promise<{ id: string; title: string }> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch("/api/market/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: template.id, txHash, workspaceId: workspace.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; title?: string; error?: string };
      if (res.ok && body.id) return { id: body.id, title: body.title ?? template.title };
      if (res.status !== 402 || attempt >= 3) {
        throw new Error(body.error || "Bought, but the copy couldn't be made. Use the template again from the gallery.");
      }
      await sleep(2000);
    }
  }

  /** Already bought (the copy failed last time): just copy it again. */
  async function copyOwned() {
    if (busy || !canCreate) return;
    setError(null);
    try {
      setStep("copying");
      const note = await claim(null);
      onOpenChange(false);
      onBought(note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The template couldn't be copied.");
    } finally {
      setStep(null);
    }
  }

  async function buy() {
    if (!quote || quote.problems.length > 0 || busy || !canCreate) return;
    setError(null);
    let txHash: string | null = null;
    try {
      setStep("signing");
      const address = await wallet.ensureWallet();
      ({ txHash } = await TemplateMarket.buy(address, template.id, quote.template.token, quote.price));
      setStep("copying");
      const note = await claim(txHash);
      const hash = txHash;
      toast.success(`Bought “${template.title}”`, {
        action: { label: "View tx", onClick: () => window.open(expertTxUrl(hash), "_blank", "noopener,noreferrer") },
      });
      onOpenChange(false);
      onBought(note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The purchase failed.");
      // Paid but not copied: the purchase is on-chain, so "Use again" works later.
      if (txHash) setQuoteRun((n) => n + 1);
    } finally {
      setStep(null);
      void wallet.refreshBalance();
    }
  }

  const code = quote?.token.code ?? template.tokenCode;
  const amount = (units: bigint) => `${formatAmount(units)} ${code}`;
  const blocked = !quote || quote.problems.length > 0 || !canCreate;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[440px]" data-testid="buy-template-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingBagIcon className="text-foreground size-4" strokeWidth={1.5} />
            Buy template
          </DialogTitle>
          <DialogDescription>
            You pay in one transaction, straight to the people below. Doqtri never holds the money.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-[12px]">
          <p className="text-foreground truncate text-[13px] font-semibold">{template.title}</p>

          {quoting && !quote ? (
            <p className="text-muted-foreground flex items-center gap-2 py-4">
              <Loader2Icon className="size-3.5 animate-spin" /> Checking price, balance and fees…
            </p>
          ) : quote?.owned ? (
            <p className="glass rounded-xl px-3 py-2.5" data-testid="buy-owned">
              You already bought this template. Add another copy to your vault for free.
            </p>
          ) : quote ? (
            <dl className="glass grid gap-1.5 rounded-xl px-3 py-2.5" data-testid="buy-quote">
              <Row label="Price" value={amount(quote.price)} strong />
              <Row
                label={`Creator receives (${shortAddress(quote.template.creator)})`}
                value={amount(quote.creatorCut)}
              />
              {quote.parentCut > BigInt(0) ? (
                <Row
                  label={`Original creator receives${template.parent ? ` (“${template.parent.title}”)` : ""}`}
                  value={amount(quote.parentCut)}
                />
              ) : null}
              <Row label="Doqtri fee" value={amount(quote.treasuryCut)} />
              <Row
                label="Network fee"
                value={`${quote.feeIsCap ? "up to" : "about"} ${formatAmount(quote.feeStroops)} XLM`}
              />
              <Row
                label="Your balance"
                value={quote.balance === null ? "—" : amount(quote.balance)}
              />
            </dl>
          ) : null}

          {quote && quote.problems.length > 0 ? (
            <ul role="alert" className="text-destructive grid list-disc gap-1 pl-4" data-testid="buy-problems">
              {quote.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          {!canCreate ? (
            <p role="alert" className="text-destructive" data-testid="buy-viewer">
              You&apos;re a viewer in {workspace.name}, so a copy can&apos;t be added to it. Switch to a workspace you
              edit first.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy || quoting} onClick={refresh}>
            {quoting ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Refresh
          </Button>
          {quote?.owned ? (
            <Button type="button" disabled={busy || quoting} onClick={() => void copyOwned()} data-testid="buy-copy-owned">
              {busy ? <Loader2Icon className="animate-spin" /> : <FilePlus2Icon />}
              {step ? STEP_LABELS[step] : "Add to vault"}
            </Button>
          ) : (
            <Button type="button" disabled={blocked || busy || quoting} onClick={() => void buy()} data-testid="buy-confirm">
              {busy ? <Loader2Icon className="animate-spin" /> : <ShoppingBagIcon />}
              {step ? STEP_LABELS[step] : quote ? `Buy for ${amount(quote.price)}` : "Buy"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground min-w-0 truncate">{label}</dt>
      <dd className={strong ? "text-foreground shrink-0 font-semibold" : "text-foreground shrink-0"}>{value}</dd>
    </div>
  );
}
