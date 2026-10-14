"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { connectWallet } from "@/lib/wallet";
import { exchangeWalletSession } from "@/lib/wallet-session";
import { markReturningVisitor } from "@/lib/returning-visitor";
import { cn } from "@/lib/utils";

type Props = {
  className?: string;
  size?: "default" | "lg" | "sm";
  variant?: "default" | "ghost" | "outline";
  label?: string;
  /** Same-site path to open once signed in. */
  next?: string;
};

export function ConnectWalletButton({
  className,
  size = "default",
  variant = "default",
  label = "Connect wallet",
  next = "/vault",
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleConnect() {
    setBusy(true);
    try {
      const address = await connectWallet();
      await exchangeWalletSession(address);
      markReturningVisitor();

      router.refresh();
      router.push(next);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not connect wallet";
      toast.error(message);
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      disabled={busy}
      className={cn(className)}
      onClick={() => void handleConnect()}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <WalletIcon />}
      {busy ? "Connecting…" : label}
    </Button>
  );
}
