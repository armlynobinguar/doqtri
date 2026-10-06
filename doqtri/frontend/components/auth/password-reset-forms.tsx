"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2Icon, MailCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Turnstile, TURNSTILE_SITE_KEY, type TurnstileHandle } from "@/components/auth/turnstile";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { confirmUrl, MIN_PASSWORD_LENGTH } from "@/lib/email-auth";

/** Step 1: email a reset link that signs the user in and lands on /reset-password. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captcha = useRef<TurnstileHandle>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const token = captchaToken ?? undefined;
    captcha.current?.reset();
    const { error: resetError } = await createSupabaseBrowserClient().auth.resetPasswordForEmail(
      email.trim(),
      { redirectTo: confirmUrl(window.location.origin, "/reset-password"), captchaToken: token },
    );
    setBusy(false);
    if (resetError) setError(resetError.message);
    else setSent(true);
  }

  if (sent) {
    return (
      <div data-testid="reset-sent" className="flex flex-col gap-2 text-[13px]">
        <p className="flex items-center gap-2 font-medium">
          <MailCheckIcon className="size-4" /> Check your inbox
        </p>
        <p className="text-muted-foreground leading-relaxed">
          If an account exists for <span className="text-foreground">{email.trim()}</span>, a reset
          link is on its way. Open it on this device.
        </p>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={(e) => void submit(e)}>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="text-muted-foreground">Email</span>
        <Input
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <Turnstile ref={captcha} onToken={setCaptchaToken} />
      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        size="lg"
        disabled={busy || (Boolean(TURNSTILE_SITE_KEY) && !captchaToken)}
        className="mt-1 w-full"
      >
        {busy ? <Loader2Icon className="animate-spin" /> : null}
        Send reset link
      </Button>
      <p className="text-muted-foreground text-center text-[12px]">
        <Link href="/login" className="text-foreground underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

/** Step 2: the reset link opened a session; set the new password on it. */
export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: updateError } = await createSupabaseBrowserClient().auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }
    router.refresh();
    router.push("/vault");
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={(e) => void submit(e)}>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="text-muted-foreground">New password</span>
        <Input
          type="password"
          name="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
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
      <Button type="submit" size="lg" disabled={busy} className="mt-1 w-full">
        {busy ? <Loader2Icon className="animate-spin" /> : null}
        Save password
      </Button>
    </form>
  );
}
