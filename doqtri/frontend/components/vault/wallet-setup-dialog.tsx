"use client";

import { useEffect, useState } from "react";
import { CircleCheckIcon, CircleIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWallet } from "@/components/vault/wallet-provider";
import { passkeysSupported } from "@/lib/passkey-wallet";
import { expertTxUrl, IS_MAINNET } from "@/lib/stellar/config";
import { USER_PAYS_FEES } from "@/lib/stellar/smart-wallet-config";
import { cn } from "@/lib/utils";

/** Set when the user chooses "Later", so the dialog doesn't reopen on every visit this session. */
const DISMISSED_KEY = "doqtri.walletSetupDismissed";

type StepState = "todo" | "working" | "done";

/**
 * The step after email sign-up: an email account has no wallet yet, so the
 * vault opens this once and the user creates one with a single passkey prompt.
 * The deploy and (on testnet) the first test XLM follow on their own, and the
 * dialog shows each step until the wallet can anchor.
 *
 * WebAuthn needs a click to start, so this can't run with no tap at all; it is
 * the one tap.
 */
export function WalletSetupDialog() {
  const wallet = useWallet();
  const needsWallet = wallet.identity.kind === "email" && wallet.identity.smartWallet === null;
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    if (!needsWallet) return;
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      // Storage blocked: ask anyway.
    }
    if (dismissed) return;
    // Deferred a tick so no state is set synchronously inside the effect.
    const timer = setTimeout(() => {
      setSupported(passkeysSupported());
      setOpen(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [needsWallet]);

  async function create() {
    setCreating(true);
    try {
      await wallet.createSmartWallet();
      setCreated(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Your wallet could not be created.");
    } finally {
      setCreating(false);
    }
  }

  function later() {
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage blocked: it just asks again next time.
    }
    setOpen(false);
  }

  const hasWallet = created || (wallet.identity.kind === "email" && wallet.identity.smartWallet !== null);
  const walletStep: StepState = hasWallet ? "done" : creating ? "working" : "todo";
  const fundsStep: StepState = !hasWallet ? "todo" : wallet.walletReady ? "done" : "working";
  const ready = hasWallet && wallet.walletReady;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : creating ? undefined : later())}>
      <DialogContent className="sm:max-w-[420px]" data-testid="wallet-setup-dialog">
        <DialogHeader>
          <DialogTitle>{ready ? "You're ready to anchor" : "Finish setting up your vault"}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {ready
              ? "Save & anchor any note to put its fingerprint on Stellar. Your wallet signs with this passkey."
              : "Doqtri anchors your notes on Stellar with a wallet that only your passkey can open: your fingerprint, face or device PIN. No seed phrase, no extension."}
          </DialogDescription>
        </DialogHeader>

        <ol className="grid gap-2 text-[13px]" data-testid="wallet-setup-steps">
          <Step state={walletStep} label="Create your passkey and wallet" detail="One prompt from your browser" />
          {USER_PAYS_FEES && !IS_MAINNET ? (
            <Step
              state={fundsStep}
              label="Add free test XLM for network fees"
              detail={fundsStep === "working" ? "Usually about 10 seconds" : "Added automatically"}
            />
          ) : null}
        </ol>

        {ready && wallet.identity.kind === "email" && wallet.identity.smartWallet ? (
          <p className="text-muted-foreground text-[12px]" data-testid="wallet-setup-receipt">
            Your sign-up is recorded on Stellar:{" "}
            <a
              href={expertTxUrl(wallet.identity.smartWallet.createdTx)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground font-mono underline-offset-2 hover:underline"
            >
              wallet created in tx {wallet.identity.smartWallet.createdTx.slice(0, 6)}…
            </a>
          </p>
        ) : null}

        {!supported ? (
          <p className="text-warning text-[12px]">
            This browser can&apos;t create passkeys. Open Doqtri in a recent Chrome, Safari, Edge or Firefox to
            create your wallet. You can still write and save notes here.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {ready ? (
            <Button type="button" onClick={() => setOpen(false)} data-testid="wallet-setup-done">
              Start writing
            </Button>
          ) : hasWallet ? (
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Continue in the background
            </Button>
          ) : (
            <>
              <Button
                type="button"
                disabled={creating || !supported}
                onClick={() => void create()}
                data-testid="wallet-setup-create"
              >
                {creating ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
                {creating ? "Creating your wallet…" : "Create passkey"}
              </Button>
              <Button type="button" variant="ghost" disabled={creating} onClick={later}>
                Later
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step({ state, label, detail }: { state: StepState; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2.5" data-state={state}>
      {state === "done" ? (
        <CircleCheckIcon className="text-success mt-0.5 size-4 shrink-0" />
      ) : state === "working" ? (
        <Loader2Icon className="text-muted-foreground mt-0.5 size-4 shrink-0 animate-spin" />
      ) : (
        <CircleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      )}
      <span className="grid">
        <span className={cn(state === "todo" && "text-muted-foreground")}>{label}</span>
        <span className="text-muted-foreground text-[12px]">{detail}</span>
      </span>
    </li>
  );
}
