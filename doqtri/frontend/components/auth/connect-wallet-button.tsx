"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { connectWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";

type Props = {
  className?: string;
  size?: "default" | "lg" | "sm";
  label?: string;
};

export function ConnectWalletButton({
  className,
  size = "default",
  label = "Connect wallet",
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleConnect() {
    setBusy(true);
    try {
      const address = await connectWallet();
      const res = await fetch("/api/auth/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const payload = (await res.json()) as {
        error?: string;
        access_token?: string;
        refresh_token?: string;
      };
      if (!res.ok || !payload.access_token || !payload.refresh_token) {
        throw new Error(payload.error ?? "Wallet login failed");
      }

      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.setSession({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
      });
      if (error) throw error;

      router.refresh();
      router.push("/vault");
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
      disabled={busy}
      className={cn(className)}
      onClick={() => void handleConnect()}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <WalletIcon />}
      {busy ? "Connecting…" : label}
    </Button>
  );
}
