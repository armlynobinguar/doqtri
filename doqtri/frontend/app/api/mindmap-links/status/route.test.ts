import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * POST /api/mindmap-links/status (WP-4.7, DOQ-54; contract v1.5.0): public,
 * rate-limited, liveness only. The service-role client is a fake that
 * answers consume_rate_limit() and mindmap_share_statuses() the way the SQL
 * does (backend/tests/mindmap_share_expiry.test.sql tests the SQL itself).
 */

const LIVE = "LiveLinkToken_0123456789abcd";
const EXPIRING = "ExpiringToken_0123456789abc";
const REVOKED = "RevokedToken_0123456789abcd";
const EXPIRED = "ExpiredToken_0123456789abcd";
const UNKNOWN = "UnknownToken_0123456789abcd";

/** mindmap_share_statuses() rows by token: what the database holds. */
const ROWS: Record<string, { token: string; live: boolean; expires_at: string | null }> = {
  [LIVE]: { token: LIVE, live: true, expires_at: null },
  [EXPIRING]: { token: EXPIRING, live: true, expires_at: "2026-11-21T08:00:00+00:00" },
  [REVOKED]: { token: REVOKED, live: false, expires_at: null },
  [EXPIRED]: { token: EXPIRED, live: false, expires_at: null },
};

let limit: { allowed: boolean; refused_by: string | null; retry_after_seconds: number } | null;
let limitError: { message: string } | null;
let statusError: { message: string } | null;
const calls: [string, Record<string, unknown>][] = [];

const admin = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    if (name === "consume_rate_limit") return limitError ? { data: null, error: limitError } : { data: [limit], error: null };
    if (name === "mindmap_share_statuses") {
      if (statusError) return { data: null, error: statusError };
      return { data: (args.p_tokens as string[]).flatMap((t) => (ROWS[t] ? [ROWS[t]] : [])), error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  },
};
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: () => admin,
  createSupabaseServerClient: async () => {
    throw new Error("no session is read here");
  },
}));

const { POST } = await import("./route");

const ask = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/mindmap-links/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9, 10.0.0.1", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  limit = { allowed: true, refused_by: null, retry_after_seconds: 0 };
  limitError = null;
  statusError = null;
  calls.length = 0;
});

describe("POST /api/mindmap-links/status", () => {
  it("answers live, expiring, revoked, expired and unknown tokens in one batch, with no sign-in", async () => {
    const res = await ask({ tokens: [LIVE, EXPIRING, REVOKED, EXPIRED, UNKNOWN] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      links: {
        [LIVE]: { live: true, expires_at: null },
        [EXPIRING]: { live: true, expires_at: "2026-11-21T08:00:00.000Z" },
        [REVOKED]: { live: false, expires_at: null },
        [EXPIRED]: { live: false, expires_at: null },
        [UNKNOWN]: { live: false, expires_at: null },
      },
    });
    expect(calls.map(([name]) => name)).toEqual(["consume_rate_limit", "mindmap_share_statuses"]);
  });

  it("is cached by the caller for at most 60 seconds", async () => {
    const res = await ask({ tokens: [LIVE] });
    const cache = res.headers.get("cache-control") ?? "";
    const maxAge = Number(/max-age=(\d+)/.exec(cache)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(60);
  });

  it("returns liveness only: nothing of the graph, the workspace or the sender", async () => {
    const body = (await (await ask({ tokens: [LIVE, EXPIRING] })).json()) as { links: Record<string, object> };
    expect(Object.keys(body)).toEqual(["links"]);
    for (const status of Object.values(body.links)) expect(Object.keys(status).sort()).toEqual(["expires_at", "live"]);
  });

  it("answers an empty batch with no links", async () => {
    const res = await ask({ tokens: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ links: {} });
    expect(calls.map(([name]) => name)).toEqual(["consume_rate_limit"]);
  });

  it.each([
    ["not JSON", "{tokens:"],
    ["not an object", JSON.stringify([LIVE])],
    ["no tokens", JSON.stringify({})],
    ["tokens not a list", JSON.stringify({ tokens: LIVE })],
    ["over 500 tokens", JSON.stringify({ tokens: Array(501).fill(LIVE) })],
    ["a malformed token", JSON.stringify({ tokens: [LIVE, "short"] })],
    ["a whole link instead of a token", JSON.stringify({ tokens: [`https://doqtri.test/m/${LIVE}`] })],
  ])("refuses %s with 400, without reading any link", async (_name, body) => {
    const res = await ask(body);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls.map(([name]) => name)).not.toContain("mindmap_share_statuses");
  });

  it("refuses a body over 64 KiB with 413", async () => {
    const res = await ask({ tokens: [LIVE], pad: "x".repeat(70 * 1024) });
    expect(res.status).toBe(413);
  });

  it("counts each caller by a hash of its address, never the address, per minute", async () => {
    await ask({ tokens: [LIVE] });
    const [, args] = calls[0];
    expect(args).toMatchObject({ p_scope: "mindmap-link-status", p_window_seconds: 60 });
    expect(args.p_client).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(args)).not.toContain("203.0.113.9");
    calls.length = 0;
    await ask({ tokens: [LIVE] }, { "x-forwarded-for": "198.51.100.7" });
    expect(calls[0][1].p_client).not.toBe(args.p_client);
  });

  it("answers 429 with Retry-After once the limit is passed, before reading any link", async () => {
    limit = { allowed: false, refused_by: "client", retry_after_seconds: 17 };
    const res = await ask({ tokens: [LIVE] });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(calls.map(([name]) => name)).toEqual(["consume_rate_limit"]);
  });

  it("answers 503 when the limit cannot be counted (fails closed)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    limitError = { message: "function consume_rate_limit does not exist" };
    expect((await ask({ tokens: [LIVE] })).status).toBe(503);
    log.mockRestore();
  });

  it("answers 503, not 'not live', when the links cannot be read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    statusError = { message: "down" };
    const res = await ask({ tokens: [LIVE] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    log.mockRestore();
  });
});
