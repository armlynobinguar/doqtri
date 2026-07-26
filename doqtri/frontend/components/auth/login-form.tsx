"use client";

import { ConnectWalletButton } from "@/components/auth/connect-wallet-button";

/** Kept as /login fallback — same Connect wallet flow as the landing. */
export function LoginForm() {
  return (
    <div className="flex w-full max-w-[320px] flex-col gap-3">
      <div className="mb-3 flex flex-col gap-1.5">
        <h1 className="text-[15px] font-medium">Open your vault</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Connect a Stellar wallet to unlock your notes, graph, and mindmap.
        </p>
      </div>
      <ConnectWalletButton className="mt-1 w-full" />
      <p className="text-muted-foreground mt-1 text-center text-[12px]">
        Freighter and other Stellar wallets supported
      </p>
    </div>
  );
}
