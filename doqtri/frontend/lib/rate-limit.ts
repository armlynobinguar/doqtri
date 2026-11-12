import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Rate limits for public routes, which have no user to charge (WP-4.7,
 * DOQ-54; server-only). Counted in Postgres like the AI and relay budgets
 * (consume_rate_limit(), backend migration 20261112200000), so every
 * serverless instance sees one count: per client and for everyone, in fixed
 * windows.
 *
 * A client is the caller's address as Vercel reports it, hashed before it
 * leaves this file: the database never holds an address.
 */

export type RateLimit =
  | { ok: true }
  | { ok: false; reason: "limited"; retryAfterSeconds: number }
  | { ok: false; reason: "unavailable" };

/**
 * The caller's address: the first entry of `x-forwarded-for` (Vercel puts the
 * client first and overwrites what the client sent), else `x-real-ip`, else
 * "unknown" (all such callers then share one count). Hashed, 32 hex digits.
 */
export function rateLimitClientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(address, "utf8").digest("hex").slice(0, 32);
}

/**
 * Counts one request of `client` to `scope`. Fails closed: when the count
 * cannot be read the caller answers 503, never an uncounted request.
 */
export async function consumeRateLimit(
  admin: SupabaseClient,
  params: { scope: string; client: string; clientLimit: number; globalLimit: number; windowSeconds: number },
): Promise<RateLimit> {
  const { data, error } = await admin.rpc("consume_rate_limit", {
    p_scope: params.scope,
    p_client: params.client,
    p_client_limit: params.clientLimit,
    p_global_limit: params.globalLimit,
    p_window_seconds: params.windowSeconds,
  });
  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed: boolean; refused_by: string | null; retry_after_seconds: number }
    | null
    | undefined;
  if (error || !row) {
    console.error(`[rate-limit] ${params.scope}: ${error?.message ?? "no row returned"}`);
    return { ok: false, reason: "unavailable" };
  }
  if (row.allowed) return { ok: true };
  return { ok: false, reason: "limited", retryAfterSeconds: Math.max(1, row.retry_after_seconds) };
}
