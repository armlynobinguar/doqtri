import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-user daily budget for the routes that call OpenAI (server-only).
 *
 * Sign-in only needs a Stellar keypair, which costs nothing to make, so every
 * AI route spends from this budget before doing any model work. The counting
 * lives in Postgres (`consume_ai_quota`, see backend/migrations) so concurrent
 * requests from one user cannot both slip under the limit.
 *
 * A request is charged when it is accepted, not when it succeeds: a model call
 * that fails or times out has still cost money, and charging up front keeps a
 * retry loop from being free.
 */

/** Routes that draw on the budget; stored per row for usage breakdowns. */
export type AiRoute = "ingest" | "ingest-retry" | "regenerate" | "mindmap";

export const DEFAULT_AI_DAILY_LIMIT = 30;

/** `AI_DAILY_LIMIT` from the environment, or the default if unset or invalid. */
export function aiDailyLimit(raw: string | undefined = process.env.AI_DAILY_LIMIT): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_AI_DAILY_LIMIT;
}

export type AiQuota =
  | { ok: true; used: number; limit: number }
  | { ok: false; reason: "exceeded"; used: number; limit: number; retryAfterSeconds: number }
  | { ok: false; reason: "unavailable" };

type QuotaRow = { allowed: boolean; used: number; retry_after_seconds: number };

/**
 * Charges one AI request to `userId`. `userId` must come from a verified
 * session — the admin client bypasses RLS and the function trusts its input.
 *
 * Fails closed: if the budget cannot be checked (e.g. the migration is not
 * applied), the request is refused rather than allowed through uncounted.
 */
export async function consumeAiQuota(
  admin: SupabaseClient,
  userId: string,
  route: AiRoute,
  limit: number = aiDailyLimit(),
): Promise<AiQuota> {
  const { data, error } = await admin.rpc("consume_ai_quota", {
    p_user_id: userId,
    p_route: route,
    p_limit: limit,
  });
  const row = (Array.isArray(data) ? data[0] : data) as QuotaRow | null | undefined;

  if (error || !row) {
    console.error(`[ai-quota] budget check failed for ${route}: ${error?.message ?? "no row returned"}`);
    return { ok: false, reason: "unavailable" };
  }
  if (row.allowed) return { ok: true, used: row.used, limit };
  return {
    ok: false,
    reason: "exceeded",
    used: row.used,
    limit,
    retryAfterSeconds: Math.max(1, row.retry_after_seconds),
  };
}

/** "about 3 hours", "about 12 minutes", "under a minute". */
export function formatWait(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Error codes, shared with the ingest error contract (lib/ingest/errors.ts). */
export const AI_LIMIT_CODES = {
  exceeded: "AI_DAILY_LIMIT",
  unavailable: "AI_LIMIT_UNAVAILABLE",
} as const;

/** The JSON refusal every AI route returns when the budget says no. */
export function quotaRefusal(quota: Exclude<AiQuota, { ok: true }>): Response {
  if (quota.reason === "unavailable") {
    return Response.json(
      {
        error: "AI features are temporarily unavailable. Try again shortly.",
        code: AI_LIMIT_CODES.unavailable,
      },
      { status: 503 },
    );
  }
  return Response.json(
    {
      error: `You've used all ${quota.limit} AI requests for today. Try again in ${formatWait(quota.retryAfterSeconds)}.`,
      code: AI_LIMIT_CODES.exceeded,
    },
    { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds) } },
  );
}
