"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { signWalletMessage } from "@/lib/wallet";

/**
 * Exchanges a connected wallet for a Supabase session and installs it in the
 * browser client: fetch a one-time challenge, have the wallet sign it, and
 * trade the signature for a session. Shared by the landing page's connect
 * button and the in-vault reconnect, so both take the same path.
 */
export async function exchangeWalletSession(address: string): Promise<void> {
  const challengeRes = await fetch("/api/auth/wallet/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const challenge = (await challengeRes.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    token?: string;
  };
  if (!challengeRes.ok || !challenge.message || !challenge.token) {
    throw new Error(challenge.error ?? "Could not start wallet login");
  }

  const signature = await signWalletMessage(challenge.message, address);

  const res = await fetch("/api/auth/wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, token: challenge.token, signature }),
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
