import { describe, expect, it, vi } from "vitest";
import { consumeRateLimit, rateLimitClientKey } from "@/lib/rate-limit";

/*
 * Public-route rate limits (WP-4.7, DOQ-54): the client key is a hash of the
 * caller's address, and consume_rate_limit()'s answer (tested in SQL in
 * backend/tests/mindmap_share_expiry.test.sql) maps onto allowed, limited or
 * unavailable, failing closed.
 */

const params = { scope: "mindmap-link-status", client: "abc", clientLimit: 2, globalLimit: 4, windowSeconds: 60 };

describe("rateLimitClientKey", () => {
  it("hashes the first forwarded address, so the database never holds it", () => {
    const key = rateLimitClientKey(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toBe(rateLimitClientKey(new Headers({ "x-forwarded-for": "203.0.113.9" })));
    expect(key).not.toBe(rateLimitClientKey(new Headers({ "x-forwarded-for": "198.51.100.7" })));
  });

  it("falls back to x-real-ip, then to one shared key", () => {
    expect(rateLimitClientKey(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe(
      rateLimitClientKey(new Headers({ "x-forwarded-for": "203.0.113.9" })),
    );
    expect(rateLimitClientKey(new Headers())).toBe(rateLimitClientKey(new Headers({ "x-forwarded-for": "" })));
  });
});

describe("consumeRateLimit", () => {
  it("passes the limits to consume_rate_limit", async () => {
    const rpc = vi.fn(async () => ({ data: [{ allowed: true, refused_by: null, retry_after_seconds: 0 }], error: null }));
    expect(await consumeRateLimit({ rpc } as never, params)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_scope: "mindmap-link-status",
      p_client: "abc",
      p_client_limit: 2,
      p_global_limit: 4,
      p_window_seconds: 60,
    });
  });

  it("is limited, with at least a second to wait, once refused", async () => {
    const rpc = vi.fn(async () => ({ data: [{ allowed: false, refused_by: "global", retry_after_seconds: 0 }], error: null }));
    expect(await consumeRateLimit({ rpc } as never, params)).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 1 });
  });

  it("is unavailable when the count cannot be read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async () => ({ data: null, error: { message: "missing" } }));
    expect(await consumeRateLimit({ rpc } as never, params)).toEqual({ ok: false, reason: "unavailable" });
    log.mockRestore();
  });
});
