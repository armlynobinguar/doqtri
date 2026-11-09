"use client";

import { useState } from "react";
import { CheckIcon, GiftIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The referral code on the sign-up screen. Filled in when the visitor came
 * through someone's link or QR code; otherwise tucked behind "Have a referral
 * code?". Applying a code stores it server-side (/api/referrals/code) before
 * the account exists, which is what lets it count, for email and wallet
 * sign-up alike.
 */
export function ReferralCodeField({ initialCode }: { initialCode: string | null }) {
  const [applied, setApplied] = useState(initialCode);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/referrals/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (!res.ok || !body.code) throw new Error(body.error ?? "Could not apply the code. Try again.");
      setApplied(body.code);
      setOpen(false);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply the code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await fetch("/api/referrals/code", { method: "DELETE" }).catch(() => {});
    setApplied(null);
    setBusy(false);
  }

  if (applied) {
    return (
      <p className="text-muted-foreground mt-1 flex items-center justify-center gap-2 text-[12px]" data-testid="referral-applied">
        <GiftIcon className="size-3.5" strokeWidth={1.5} />
        Invited with code <span className="text-foreground font-mono">{applied}</span>
        <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void remove()}>
          {busy ? <Loader2Icon className="animate-spin" /> : <XIcon strokeWidth={1.5} />}
          Remove
        </Button>
      </p>
    );
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground mt-1 self-center"
        onClick={() => setOpen(true)}
        data-testid="referral-open"
      >
        <GiftIcon strokeWidth={1.5} />
        Have a referral code?
      </Button>
    );
  }

  return (
    <form className="mt-1 flex flex-col gap-2 text-[12px]" onSubmit={(e) => void apply(e)} noValidate>
      <label className="flex flex-col gap-2">
        <span className="eyebrow text-[10px]">Referral code</span>
        <div className="flex gap-2">
          <Input
            name="referral-code"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={8}
            autoFocus
            placeholder="k7m2pq9x"
            className="font-mono"
            value={value}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setValue(e.target.value)}
            data-testid="referral-input"
          />
          <Button type="submit" variant="outline" disabled={busy || !value.trim()}>
            {busy ? <Loader2Icon className="animate-spin" /> : <CheckIcon strokeWidth={1.5} />}
            Apply
          </Button>
        </div>
      </label>
      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}
    </form>
  );
}
