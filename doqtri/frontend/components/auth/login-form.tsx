"use client";

import { ConnectWalletButton } from "@/components/auth/connect-wallet-button";
import { DoqtriMark } from "@/components/brand/doqtri-mark";

/** Kept as /login fallback — same Connect wallet flow as the landing. */
export function LoginForm() {
  return (
    <div className="bg-card flex w-full max-w-[360px] flex-col gap-3 rounded-xl border p-7 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]">
      <DoqtriMark className="mb-2 h-auto w-14 text-foreground [--mark-fill:var(--brand-elevated)]" />
      <div className="mb-3 flex flex-col gap-1.5">
        <h1 className="text-lg font-bold tracking-tight">Open your vault</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Connect a Stellar wallet to unlock your notes, graph, and mindmap.
        </p>
      </div>
      <ConnectWalletButton size="lg" className="mt-1 w-full" />
      <p className="text-muted-foreground mt-1 text-center text-[12px]">
        Freighter and other Stellar wallets supported
      </p>
    </div>
  );
}
