"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { connectWallet } from "@/lib/wallet";

export function LoginForm() {
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
    <div className="flex w-full max-w-[320px] flex-col gap-3">
      <div className="mb-3 flex flex-col gap-1.5">
        <h1 className="text-[15px] font-medium">Open your vault</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Connect a Stellar wallet to unlock your notes, graph, and mindmap.
        </p>
      </div>

      <Button
        type="button"
        disabled={busy}
        className="mt-1"
        onClick={() => void handleConnect()}
      >
        {busy ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <WalletIcon />
        )}
        {busy ? "Connecting…" : "Connect wallet"}
      </Button>

      <p className="text-muted-foreground mt-1 text-center text-[12px]">
        Freighter and other Stellar wallets supported
      </p>
    </div>
  );
}
