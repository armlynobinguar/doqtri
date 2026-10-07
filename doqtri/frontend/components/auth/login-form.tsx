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
        <p role="alert" className="glass rounded-xl px-3 py-2.5 text-[12px] before:mr-2 before:inline-block before:size-1.5 before:rounded-full before:bg-warning before:align-middle">
          {notice}
        </p>
      ) : null}
      <ConnectWalletButton size="lg" className="w-full rounded-full" />
      <p className="text-muted-foreground text-center text-[12px]">
        Freighter and other Stellar wallets supported
      </p>
      <div className="eyebrow my-2 flex items-center gap-3 text-[10px]">
        <span className="bg-border h-px flex-1" />
        or
        <span className="bg-border h-px flex-1" />
      </div>
      <EmailAuthForm mode="sign-in" />
    </AuthCard>
  );
}
