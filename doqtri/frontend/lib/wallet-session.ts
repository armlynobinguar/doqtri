"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Exchanges a connected wallet's public key for a Supabase session and
 * installs it in the browser client. Shared by the landing page's connect
 * button and the in-vault reconnect, so both take the same idempotent path.
 */
export async function exchangeWalletSession(address: string): Promise<void> {
  const res = await fetch("/api/auth/wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    access_token?: string;
    refresh_token?: string;
  };
  if (!res.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(payload.error ?? "Wallet login failed");
  }

  const { error } = await createSupabaseBrowserClient().auth.setSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
  });
  if (error) throw error;
}
