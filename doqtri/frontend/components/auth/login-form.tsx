import { AuthCard, AuthSwitch } from "@/components/auth/auth-card";
import { withNext } from "@/lib/email-auth";
import { EmailAuthForm } from "@/components/auth/email-auth-form";
import { WalletOption } from "@/components/auth/wallet-option";
import { SignUpNotice } from "@/components/legal/legal-links";

/** /login: email + password first, the wallet as a quieter second option. */
export function LoginForm({ notice, next, legalLive }: { notice?: string; next: string; legalLive: boolean }) {
  return (
    <AuthCard title="Welcome back" description="Sign in to open your notes, graph, and mindmap.">
      {notice ? (
        <p role="alert" className="glass rounded-xl px-3 py-2.5 text-[12px] before:mr-2 before:inline-block before:size-1.5 before:rounded-full before:bg-warning before:align-middle">
          {notice}
        </p>
      ) : null}
      <EmailAuthForm mode="sign-in" next={next} />
      <WalletOption next={next} />
      {/* The wallet button also creates an account, the first time a wallet connects. */}
      {legalLive && <SignUpNotice className="mt-1" />}
      <AuthSwitch prompt="New to Doqtri?" href={withNext("/signup", next)} label="Create an account" />
    </AuthCard>
  );
}
