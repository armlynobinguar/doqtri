import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { MAX_STATUS_BODY_BYTES, parseStatusRequest } from "@/lib/mindmap-share";
import { loadMindmapLinkStatuses, type MindmapLinkStatus } from "@/lib/mindmap-share-server";
import { consumeRateLimit, rateLimitClientKey } from "@/lib/rate-limit";

/**
 * POST /api/mindmap-links/status (WP-4.7, DOQ-54; contract v1.5.0, end of
 * section 8): whether public mindmap links are still live, for qdit
 * (QDIT-67) to decide whether to prefill, show or export a link. Public: no
 * session, no qdit token and no signature, since the token is the only
 * secret and the answer is only liveness.
 *
 *   request   {"tokens": ["<token>", ...]}: 1 to 500 tokens of the /m/<token>
 *             shape, repeats allowed; at most 64 KiB. Anything else is 400
 *             with section 6's error body (`invalid_request`).
 *   answer    200 {"links": {"<token>": {"live": bool, "expires_at": string|null}}},
 *             one key per distinct token. A revoked, expired or unknown token
 *             is {"live": false, "expires_at": null}, so they cannot be told
 *             apart. expires_at is set only for a live link whose hackathon
 *             has released its grades (released_at + 24 h, ISO 8601 UTC).
 *             Never the graph, the workspace, the hackathon or the sender.
 *   limits    per minute, per caller address and in total (429
 *             `rate_limited` with Retry-After); 503 `unavailable` when doqtri
 *             cannot answer. qdit treats any non-200 as "unknown" and shows
 *             the link.
 *
 * qdit calls from Vercel's shared outbound addresses and has no credential
 * here to tell its calls apart, so the per-address limit is set high enough
 * that all of qdit behind one address fits (it sends one request per page
 * view or export, each up to 500 tokens, and caches answers for 60 s); the
 * total limit is what bounds the database work.
 *
 * Cache-Control: private, max-age=60 on an answer, so a revoke reaches qdit
 * within a minute; no-store on errors. Not behind the qdit flags: links made
 * while they were on keep their status after. proxy.ts never runs for /api/
 * (its matcher), so nothing there redirects a signed-out caller.
 */

/** Requests per minute from one caller address, and from everyone. */
const STATUS_RATE_LIMIT = { clientLimit: 600, globalLimit: 1200, windowSeconds: 60 } as const;

const CACHE_SECONDS = 60;

type ErrorCode = "invalid_request" | "rate_limited" | "unavailable";
type StatusAnswer =
  | { links: Record<string, MindmapLinkStatus> }
  | { error: { code: ErrorCode; message: string; details: Record<string, unknown> | null } };

const reply = (status: number, body: StatusAnswer, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Section 6's error body. */
const fail = (
  status: number,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> | null = null,
  headers?: Record<string, string>,
) => reply(status, { error: { code, message, details } }, headers);

const invalid = (field: string, problem: string) =>
  fail(400, "invalid_request", "The request is not a valid link status request.", { fields: { [field]: problem } });

const UNAVAILABLE = "Link status is unavailable. Retry later.";

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_STATUS_BODY_BYTES) return invalid("body", "is over 65536 bytes");

  const admin = createSupabaseAdminClient();
  const limit = await consumeRateLimit(admin, {
    scope: "mindmap-link-status",
    client: rateLimitClientKey(request.headers),
    ...STATUS_RATE_LIMIT,
  });
  if (!limit.ok) {
    return limit.reason === "limited"
      ? fail(429, "rate_limited", "Too many requests.", null, { "Retry-After": String(limit.retryAfterSeconds) })
      : fail(503, "unavailable", UNAVAILABLE);
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_STATUS_BODY_BYTES) return invalid("body", "is over 65536 bytes");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return invalid("body", "is not valid JSON");
  }
  const tokens = parseStatusRequest(body);
  if (!tokens) return invalid("tokens", "must be an array of 1 to 500 mindmap link tokens");

  try {
    const links = await loadMindmapLinkStatuses(admin, tokens);
    return reply(200, { links }, { "Cache-Control": `private, max-age=${CACHE_SECONDS}` });
  } catch (error) {
    console.error(`[mindmap-links] ${(error as Error).message}`);
    return fail(503, "unavailable", UNAVAILABLE);
  }
}
