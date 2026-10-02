import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  AI_LIMIT_CODES,
  DEFAULT_AI_DAILY_LIMIT,
  aiDailyLimit,
  consumeAiQuota,
  formatWait,
  quotaRefusal,
} from "./ai-quota";
import { INGEST_ERROR_CODES } from "./ingest/errors";

/** A stand-in admin client whose `rpc` answers like PostgREST does for a set-returning function. */
function fakeAdmin(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { admin: { rpc } as unknown as SupabaseClient, rpc };
}

describe("aiDailyLimit", () => {
  it("reads a positive integer from the environment value", () => {
    expect(aiDailyLimit("5")).toBe(5);
  });

  it.each([undefined, "", "0", "-3", "2.5", "lots"])("falls back to the default for %j", (raw) => {
    expect(aiDailyLimit(raw)).toBe(DEFAULT_AI_DAILY_LIMIT);
  });
});

describe("consumeAiQuota", () => {
  it("passes the user, route and limit to the database function", async () => {
    const { admin, rpc } = fakeAdmin({ data: [{ allowed: true, used: 1, retry_after_seconds: 0 }], error: null });
    await consumeAiQuota(admin, "user-1", "mindmap", 7);
    expect(rpc).toHaveBeenCalledWith("consume_ai_quota", { p_user_id: "user-1", p_route: "mindmap", p_limit: 7 });
  });

  it("allows a request under the limit", async () => {
    const { admin } = fakeAdmin({ data: [{ allowed: true, used: 3, retry_after_seconds: 0 }], error: null });
    expect(await consumeAiQuota(admin, "user-1", "ingest", 10)).toEqual({ ok: true, used: 3, limit: 10 });
  });

  it("refuses a request over the limit and says when a slot frees", async () => {
    const { admin } = fakeAdmin({ data: [{ allowed: false, used: 10, retry_after_seconds: 5400 }], error: null });
    expect(await consumeAiQuota(admin, "user-1", "regenerate", 10)).toEqual({
      ok: false,
      reason: "exceeded",
      used: 10,
      limit: 10,
      retryAfterSeconds: 5400,
    });
  });

  it("fails closed when the budget cannot be checked", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({ data: null, error: { message: "function consume_ai_quota does not exist" } });
    expect(await consumeAiQuota(admin, "user-1", "ingest", 10)).toEqual({ ok: false, reason: "unavailable" });
    warn.mockRestore();
  });

  it("fails closed when the database returns no row", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({ data: [], error: null });
    expect(await consumeAiQuota(admin, "user-1", "ingest", 10)).toEqual({ ok: false, reason: "unavailable" });
    warn.mockRestore();
  });
});

describe("formatWait", () => {
  it.each([
    [30, "under a minute"],
    [60, "about 1 minute"],
    [61, "about 2 minutes"],
    [59 * 60, "about 59 minutes"],
    [3599, "about 1 hour"],
    [3600, "about 1 hour"],
    [5 * 3600 + 1200, "about 5 hours"],
  ])("%i seconds -> %s", (seconds, text) => {
    expect(formatWait(seconds)).toBe(text);
  });
});

describe("quotaRefusal", () => {
  it("answers 429 with Retry-After and the exact wait when the budget is spent", async () => {
    const res = quotaRefusal({ ok: false, reason: "exceeded", used: 30, limit: 30, retryAfterSeconds: 7200 });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7200");
    expect(await res.json()).toEqual({
      error: "You've used all 30 AI requests for today. Try again in about 2 hours.",
      code: "AI_DAILY_LIMIT",
    });
  });

  it("answers 503 when the budget cannot be checked", async () => {
    const res = quotaRefusal({ ok: false, reason: "unavailable" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("AI_LIMIT_UNAVAILABLE");
  });

  it("uses codes the upload dialog understands", () => {
    // lib/ingest/client.ts maps unknown codes to CONNECTION_LOST, which would
    // tell the user to retry into the same wall.
    for (const code of Object.values(AI_LIMIT_CODES)) {
      expect(INGEST_ERROR_CODES).toContain(code);
    }
  });
});
