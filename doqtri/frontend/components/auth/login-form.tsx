"use client";

import { ConnectWalletButton } from "@/components/auth/connect-wallet-button";
import { AuthCard } from "@/components/auth/auth-card";
import { EmailAuthForm } from "@/components/auth/email-auth-form";

/** /login: a Stellar wallet or email + password, side by side. */
export function LoginForm({ notice }: { notice?: string }) {
  return (
    <AuthCard
      title="Open your vault"
      description="Connect a Stellar wallet, or sign in with email, to unlock your notes, graph, and mindmap."
    >
      {notice ? (
        <p role="alert" className="border-warning/40 bg-warning/5 rounded-md border px-2.5 py-2 text-[12px]">
          {notice}
        </p>
      ) : null}
      <ConnectWalletButton size="lg" className="w-full" />
      <p className="text-muted-foreground text-center text-[12px]">
        Freighter and other Stellar wallets supported
      </p>
      <div className="text-muted-foreground my-1 flex items-center gap-3 text-[11px] tracking-wider uppercase">
        <span className="bg-border h-px flex-1" />
        or
        <span className="bg-border h-px flex-1" />
      </div>
      <EmailAuthForm mode="sign-in" />
    </AuthCard>
  );
}
