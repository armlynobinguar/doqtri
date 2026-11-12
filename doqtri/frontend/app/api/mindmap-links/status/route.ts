import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { MAX_STATUS_BODY_BYTES, parseStatusRequest } from "@/lib/mindmap-share";
import { loadMindmapLinkStatuses, type MindmapLinkStatus } from "@/lib/mindmap-share-server";
import { consumeRateLimit, rateLimitClientKey } from "@/lib/rate-limit";

/**
 * POST /api/mindmap-links/status (WP-4.7, DOQ-54; contract v1.5.0): whether
 * public mindmap links are still live, for qdit (QDIT-67) to decide whether
 * to prefill or show a link. Public: no session and no qdit token, since the
 * token is the only secret and the answer is only liveness.
 *
 *   request   {"tokens": ["<token>", ...]}: 0 to 500 tokens of the /m/<token>
 *             shape. Anything else is 400; a body over 64 KiB is 413.
 *   answer    200 {"links": {"<token>": {"live": bool, "expires_at": string|null}}}
 *             with every token asked about. A revoked, expired or unknown token
 *             is {"live": false, "expires_at": null}, so they cannot be told
 *             apart. expires_at is set only for a live link whose hackathon
 *             has released its grades (released_at + 24 h, ISO 8601 UTC).
 *             Never the graph, the workspace, the hackathon or the sender.
 *   limits    per caller address and in total, per minute (429 with
 *             Retry-After); 503 when doqtri cannot answer. qdit treats any
 *             non-200 as "unknown" and shows the link.
 *
 * Cached by the caller for at most 60 s (Cache-Control), so a revoke reaches
 * qdit within a minute. Not behind the qdit flags: links made while they were
 * on keep their status after. proxy.ts never runs for /api/ (its matcher), so
 * nothing there redirects a signed-out caller.
 */

/** Requests per minute from one caller address, and from everyone. */
const STATUS_RATE_LIMIT = { clientLimit: 120, globalLimit: 1200, windowSeconds: 60 } as const;

const CACHE_SECONDS = 60;

type StatusAnswer = { links: Record<string, MindmapLinkStatus> } | { error: string };

const reply = (status: number, body: StatusAnswer, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_STATUS_BODY_BYTES) return reply(413, { error: "Body too large" });

  const admin = createSupabaseAdminClient();
  const limit = await consumeRateLimit(admin, {
    scope: "mindmap-link-status",
    client: rateLimitClientKey(request.headers),
    ...STATUS_RATE_LIMIT,
  });
  if (!limit.ok) {
    return limit.reason === "limited"
      ? reply(429, { error: "Too many requests" }, { "Retry-After": String(limit.retryAfterSeconds) })
      : reply(503, { error: "Link status is unavailable. Retry later." });
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_STATUS_BODY_BYTES) return reply(413, { error: "Body too large" });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return reply(400, { error: "The body is not valid JSON." });
  }
  const tokens = parseStatusRequest(body);
  if (!tokens) {
    return reply(400, { error: 'Send {"tokens": [...]} with at most 500 mindmap link tokens.' });
  }

  try {
    const links = await loadMindmapLinkStatuses(admin, tokens);
    return reply(200, { links }, { "Cache-Control": `private, max-age=${CACHE_SECONDS}` });
  } catch (error) {
    console.error(`[mindmap-links] ${(error as Error).message}`);
    return reply(503, { error: "Link status is unavailable. Retry later." });
  }
}
