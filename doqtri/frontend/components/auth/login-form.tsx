"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

export function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);

    const supabase = createSupabaseBrowserClient();
    const { data, error } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (error) {
      setBusy(false);
      toast.error(error.message);
      return;
    }

    // With email confirmation enabled, sign-up returns a user but no session.
    if (!data.session) {
      setBusy(false);
      toast.success("Check your inbox to confirm your email, then sign in.");
      setMode("signin");
      return;
    }

    router.refresh();
    router.push("/vault");
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-[320px] flex-col gap-3">
      <div className="mb-3 flex flex-col gap-1.5">
        <h1 className="text-[15px] font-medium">
          {mode === "signin" ? "Open your vault" : "Create a vault"}
        </h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Documents in, markdown out, graph derived.
        </p>
      </div>

      <Input
        type="email"
        required
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={busy}
      />
      <Input
        type="password"
        required
        minLength={6}
        autoComplete={mode === "signin" ? "current-password" : "new-password"}
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        disabled={busy}
      />

      <Button type="submit" disabled={busy} className="mt-1">
        {busy && <Loader2Icon className="animate-spin" />}
        {mode === "signin" ? "Sign in" : "Sign up"}
      </Button>

      <button
        type="button"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        disabled={busy}
        className="text-muted-foreground hover:text-foreground mt-1 text-[12px] transition-colors"
      >
        {mode === "signin"
          ? "No vault yet? Create one"
          : "Already have a vault? Sign in"}
      </button>
    </form>
  );
}
