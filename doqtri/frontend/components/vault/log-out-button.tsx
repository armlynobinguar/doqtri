"use client";

import { useState } from "react";
import { Loader2Icon, LogOutIcon } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/components/vault/wallet-provider";
import { cn } from "@/lib/utils";

/**
 * Log out in one click, beside the account menu. Wallet accounts also drop the
 * wallet connection (`disconnect`); email accounts only end the session.
 */
export function LogOutButton({ className }: { className?: string }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);

  async function logOut() {
    setBusy(true);
    try {
      await (wallet.identity.kind === "wallet" ? wallet.disconnect() : wallet.signOut());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Log out failed");
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      data-testid="log-out"
      onClick={() => void logOut()}
      className={cn(
        "text-muted-foreground hover:text-destructive flex items-center gap-1 rounded-sm px-1.5 transition-colors disabled:opacity-50",
        className,
      )}
    >
      {busy ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : <LogOutIcon className="size-3" aria-hidden />}
      {busy ? "Logging out…" : "Log out"}
    </button>
  );
}
