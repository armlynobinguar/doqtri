"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2Icon, LogInIcon, MailCheckIcon, MailIcon, UserPlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Turnstile, TURNSTILE_SITE_KEY, type TurnstileHandle } from "@/components/auth/turnstile";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { confirmUrl, MIN_PASSWORD_LENGTH, signUpProblem, withNext } from "@/lib/email-auth";
import { isReservedEmail } from "@/lib/wallet-address";
import { markReturningVisitor } from "@/lib/returning-visitor";

type Mode = "sign-in" | "sign-up";

/**
 * Email + password, straight against Supabase Auth from the browser client,
 * which writes the session cookies proxy.ts and the server components read.
 * Sign-up ends at "check your inbox" when email confirmation is on.
 */
export function EmailAuthForm({ mode, next = "/vault" }: { mode: Mode; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captcha = useRef<TurnstileHandle>(null);
  const waitingForCaptcha = Boolean(TURNSTILE_SITE_KEY) && !captchaToken;

  const signUp = mode === "sign-up";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setUnconfirmed(false);

    const problem = signUp
      ? signUpProblem(email, password)
      : isReservedEmail(email)
        ? "Wallet accounts sign in with Use Freighter wallet, below."
        : null;
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    const supabase = createSupabaseBrowserClient();
    const token = captchaToken ?? undefined;
    // Each token is good for one request, whatever its outcome.
    captcha.current?.reset();
    try {
      if (signUp) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: confirmUrl(window.location.origin, next), captchaToken: token },
        });
        if (signUpError) throw signUpError;
        markReturningVisitor();
        // With confirmation off, Supabase signs the user in immediately.
        if (data.session) return enterVault();
        // Supabase answers an already-registered email the same way, on
        // purpose, so this screen does not reveal who has an account.
        setSentTo(email.trim());
        setBusy(false);
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
        options: { captchaToken: token },
      });
      if (signInError) {
        if (signInError.code === "email_not_confirmed") setUnconfirmed(true);
        throw signInError;
      }
      markReturningVisitor();
      enterVault();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  function enterVault() {
    router.refresh();
    router.push(next);
  }

  async function resend() {
    setBusy(true);
    const token = captchaToken ?? undefined;
    captcha.current?.reset();
    const { error: resendError } = await createSupabaseBrowserClient().auth.resend({
      type: "signup",
      email: email.trim(),
      options: { emailRedirectTo: confirmUrl(window.location.origin, next), captchaToken: token },
    });
    setBusy(false);
    if (resendError) setError(resendError.message);
    else {
      setUnconfirmed(false);
      setSentTo(email.trim());
    }
  }

  if (sentTo) {
    return (
      <div data-testid="check-inbox" className="flex flex-col gap-2 text-[13px]">
        <p className="flex items-center gap-2 font-medium">
          <MailCheckIcon className="size-4" /> Check your inbox
        </p>
        <p className="text-muted-foreground leading-relaxed">
          We sent a confirmation link to <span className="text-foreground">{sentTo}</span>. Open it on
          this device to finish {signUp ? "creating your vault" : "signing in"}.
        </p>
        {signUp ? (
          <p className="text-muted-foreground">
            No email? If you already have an account,{" "}
            <Link href={withNext("/login", next)} className="text-foreground underline-offset-2 hover:underline">
              sign in
            </Link>{" "}
            instead.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={(e) => void submit(e)} noValidate>
      <label className="flex flex-col gap-2 text-[12px]">
        <span className="eyebrow text-[10px]">Email</span>
        <Input
          type="email"
          name="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-2 text-[12px]">
        <span className="eyebrow flex justify-between text-[10px]">
          Password
          {!signUp ? (
            <Link href="/forgot-password" className="hover:text-foreground underline-offset-2 hover:underline">
              Forgot?
            </Link>
          ) : null}
        </span>
        <Input
          type="password"
          name="password"
          autoComplete={signUp ? "new-password" : "current-password"}
          minLength={signUp ? MIN_PASSWORD_LENGTH : undefined}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}
      <Turnstile ref={captcha} onToken={setCaptchaToken} />

      {unconfirmed ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || waitingForCaptcha}
          onClick={() => void resend()}
        >
          <MailIcon strokeWidth={1.5} />
          Resend confirmation email
        </Button>
      ) : null}

      <Button type="submit" size="lg" disabled={busy || waitingForCaptcha} className="mt-2 w-full rounded-full">
        {busy ? (
          <Loader2Icon className="animate-spin" />
        ) : signUp ? (
          <UserPlusIcon strokeWidth={1.5} />
        ) : (
          <LogInIcon strokeWidth={1.5} />
        )}
        {signUp ? "Create account" : "Sign in"}
      </Button>
    </form>
  );
}
