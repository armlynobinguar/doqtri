"use client";

import { useEffect, useState } from "react";
import {
  ArrowRightIcon,
  Loader2Icon,
  StoreIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { buySplit, formatAmount, MAX_TEMPLATE_DESCRIPTION, MAX_TEMPLATE_TITLE, parseAmount, type MarketFees } from "@/lib/market";
import { MARKET_TOKENS, marketToken, PAID_TEMPLATES_ENABLED } from "@/lib/stellar/market-config";
import { TemplateMarket } from "@/lib/stellar/market-client";
import { readMarketConfig } from "@/lib/stellar/market-reads";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { MarketNode, type MarketGlyph } from "@/components/brand/market-node";
import { TokenSelect } from "@/components/vault/token-select";
import { expertTxUrl, IS_MAINNET } from "@/lib/stellar/config";
import { cn } from "@/lib/utils";

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


const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Publishes a note as a community template, free or paid (progress/004).
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
  const [paid, setPaid] = useState(false);
  const [tokenCode, setTokenCode] = useState<string>("USDC");
  const [amount, setAmount] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [step, setStep] = useState<Step>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = step !== null;

  // What a sale pays the creator depends on the contract's split and on
  // whether this note was made from a community template (its creator then
  // earns the parent share). Both are read once, for the live estimate.
  const [fees, setFees] = useState<MarketFees>(DEFAULT_FEES);
  const [derived, setDerived] = useState(false);
  useEffect(() => {
    let cancelled = false;
    readMarketConfig()
      .then((c) => !cancelled && setFees(c))
      .catch(() => {});
    void createSupabaseBrowserClient()
      .from("documents")
      .select("source_template_id")
      .eq("id", docId)
      .maybeSingle()
      .then(({ data }) => !cancelled && setDerived(Boolean(data?.source_template_id)));
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // Free templates are listed in XLM (tips then need no trustline).
  const token = paid ? (MARKET_TOKENS.find((t) => t.code === tokenCode) ?? XLM) : XLM;
  const units = paid ? parseAmount(amount) : BigInt(0);
  const priceError = !paid
    ? null
    : units === null || units <= BigInt(0)
      ? "Enter a price, e.g. 3 or 2.50."
      : units < token.minPrice
        ? `The lowest price in ${token.code} is ${formatAmount(token.minPrice)}.`
        : null;

  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !title.trim() || priceError || units === null) return;
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
          price: units.toString(),
          token: token.contract,
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
              <Select
                value={category}
                onValueChange={(next) => next && setCategory(next as TemplateCategory)}
                disabled={busy}
              >
                <SelectTrigger aria-label="Category" data-testid="publish-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                className="max-h-40 resize-y text-[13px]"
              />
            </label>
            <fieldset className="text-muted-foreground grid gap-1.5 text-[12px]" disabled={busy}>
              <legend className="mb-1">Price</legend>
              <PriceChoice paid={paid} onChange={setPaid} disabled={busy} />
              {paid ? (
                <>
                  <div className="flex gap-2">
                    <Input
                      inputMode="decimal"
                      placeholder={`At least ${formatAmount(token.minPrice)}`}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      aria-invalid={amount !== "" && priceError !== null}
                      aria-label="Price"
                      className="flex-1"
                      data-testid="publish-price-amount"
                    />
                    <TokenSelect value={tokenCode} onChange={setTokenCode} disabled={busy} data-testid="publish-token" />
                  </div>
                  {amount !== "" && priceError ? <span className="text-destructive text-[11px]">{priceError}</span> : null}
                  <ReceiveEstimate
                    price={units !== null && units > BigInt(0) ? units : null}
                    code={token.code}
                    fees={fees}
                    derived={derived}
                  />
                  <span className="text-label text-[11px]">
                    Buyers pay you directly, wallet to wallet
                    {token.asset ? `; your wallet needs a ${token.code} trustline` : ""}.
                  </span>
                </>
              ) : (
                <span className="text-label text-[11px]">Anyone can use it for free and tip you in XLM.</span>
              )}
            </fieldset>
            {error ? (
              <p role="alert" className="text-destructive text-[12px]">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                <XIcon />
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !title.trim() || priceError !== null} data-testid="publish-template-continue">
                {step ? STEP_LABELS[step] : "Continue"}
                {busy ? <Loader2Icon className="animate-spin" /> : <ArrowRightIcon />}
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
                <dd className="text-foreground" data-testid="publish-confirm-price">
                  {BigInt(draft.price) === BigInt(0)
                    ? "Free"
                    : `${formatAmount(BigInt(draft.price))} ${marketToken(draft.token)?.code ?? ""}`}
                </dd>
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
                <XIcon />
                Cancel
              </Button>
              <Button type="button" disabled={busy} onClick={() => void publish()} data-testid="publish-template-sign">
                {busy ? <Loader2Icon className="animate-spin" /> : <StoreIcon />}
                {step ? STEP_LABELS[step] : "Publish on-chain"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const PRICE_OPTIONS: { paid: boolean; label: string; hint: string; glyph: MarketGlyph; testId: string }[] = [
  { paid: false, label: "Free", hint: "Tips welcome", glyph: "gift", testId: "publish-price-free" },
  { paid: true, label: "Paid", hint: "XLM or USDC", glyph: "coin", testId: "publish-price-paid" },
];

const DEFAULT_FEES: MarketFees = { creatorBps: 8500, parentBps: 500, treasuryBps: 1000 };

/** "You will receive", recomputed on every keystroke with the contract's own split. */
function ReceiveEstimate({ price, code, fees, derived }: { price: bigint | null; code: string; fees: MarketFees; derived: boolean }) {
  const split = price
    ? buySplit({ price, buyer: "buyer", creator: "you", parentCreator: derived ? "original" : null, treasury: "doqtri", fees })
    : null;
  const pct = (bps: number) => `${bps / 100}%`;
  const share = derived ? fees.creatorBps : fees.creatorBps + fees.parentBps;
  return (
    <div className="glass grid gap-1 rounded-xl px-3.5 py-3" aria-live="polite" data-testid="publish-receive">
      <span className="eyebrow text-label text-[10px]">You will receive</span>
      <span className="flex items-baseline gap-2">
        <span className="text-foreground text-3xl font-semibold tabular-nums" data-testid="publish-receive-amount">
          {split ? formatAmount(split.creatorCut) : "—"}
        </span>
        <span className="text-foreground text-[15px] font-medium">{code}</span>
        <span className="text-muted-foreground text-[12px]">per sale · {pct(share)}</span>
      </span>
      <span className="text-muted-foreground text-[11px] tabular-nums">
        {split
          ? `Doqtri fee ${formatAmount(split.treasuryCut)} ${code}` +
            (derived ? ` · original template's creator ${formatAmount(split.parentCut)} ${code}` : "")
          : `Doqtri keeps ${pct(fees.treasuryBps)}` + (derived ? `; the original template's creator gets ${pct(fees.parentBps)}` : "")}
      </span>
    </div>
  );
}

/**
 * Free / Paid as two large cards that behave like a radio group: one is always
 * selected, arrow keys move the selection, and only the selected card is in
 * the tab order.
 */
function PriceChoice({ paid, onChange, disabled }: { paid: boolean; onChange: (paid: boolean) => void; disabled: boolean }) {
  const options = PAID_TEMPLATES_ENABLED ? PRICE_OPTIONS : PRICE_OPTIONS.filter((o) => !o.paid);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || options.length < 2) return;
    event.preventDefault();
    const next = !paid;
    onChange(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-paid="${next}"]`)?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Price" className="grid grid-cols-2 gap-2" onKeyDown={onKeyDown}>
      {options.map(({ paid: value, label, hint, glyph, testId }) => {
        const selected = paid === value;
        return (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            data-paid={value}
            data-testid={testId}
            onClick={() => onChange(value)}
            className={cn(
              "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden disabled:opacity-50",
              selected
                ? "border-[var(--glass-hi)] bg-[var(--glass-strong)] text-foreground"
                : "text-muted-foreground border-[var(--glass-lo)] bg-[var(--glass)] hover:border-[var(--glass-hi)] hover:text-foreground",
            )}
          >
            <MarketNode
              glyph={glyph}
              tinted={selected}
              className={cn("size-11 shrink-0 transition-opacity", !selected && "opacity-60")}
            />
            <span className="grid min-w-0 gap-0.5">
              <span className="text-[13px] font-semibold">{label}</span>
              <span className="text-muted-foreground text-[11px] leading-snug">{hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
