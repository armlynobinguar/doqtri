import { describe, expect, it, vi } from "vitest";
import type { ConnectionStore, StoredConnection } from "./connection-store";
import type { QditConfig } from "./qdit-config";
import type { TokenSet } from "./qdit-oauth";
import { createQditClient, errorFromResponse, parseRetryAfter, QditError, QditNotConnectedError } from "./qdit-client";

const ANA = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const config: QditConfig = {
  apiBaseUrl: "https://qdit.test/api/v1",
  issuer: "https://auth.qdit.test/auth/v1",
  clientId: "client",
  clientSecret: "secret",
  redirectUri: null,
  tokenKey: "unused",
};
const TOKEN_URL = "https://auth.qdit.test/auth/v1/oauth/token";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** integration_connections for one user, in memory, with the generation check. */
function memoryStore(initial: Partial<StoredConnection> | null) {
  let row: StoredConnection | null = initial
    ? {
        userId: ANA,
        subject: "qdit-ana",
        accountLabel: "ana",
        scopes: ["openid"],
        status: "connected",
        generation: 1,
        expiresAt: NOW + 3600_000,
        accessToken: "at1",
        refreshToken: "rt1",
        ...initial,
      }
    : null;
  const store: ConnectionStore & { row: () => StoredConnection | null; set: (r: Partial<StoredConnection>) => void } = {
    row: () => row,
    set: (r) => {
      row = { ...row!, ...r };
    },
    load: vi.fn(async () => (row ? { ...row } : null)),
    saveConnected: vi.fn(async () => {}),
    saveRefreshed: vi.fn(async (_userId: string, generation: number, tokens: TokenSet) => {
      if (!row || row.generation !== generation) return false;
      row = {
        ...row,
        status: "connected",
        generation: generation + 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? row.refreshToken,
        expiresAt: tokens.expiresAt,
      };
      return true;
    }),
    markStatus: vi.fn(async (_userId: string, generation: number, status: "needs_reconnect" | "revoked") => {
      if (!row || row.generation !== generation) return false;
      row = { ...row, status, generation: generation + 1, accessToken: null, refreshToken: null, expiresAt: null };
      return true;
    }),
  };
  return store;
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
}
const bearer = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;
const tokenResponse = (n: number) =>
  json(200, { access_token: `at${n}`, token_type: "bearer", expires_in: 3600, refresh_token: `rt${n}` });

const ME = { user: { id: "qdit-ana", username: "ana", display_name: null, avatar_url: null, wallet_address: null }, client_id: "client" };

describe("requests", () => {
  it("sends the stored access token and unwraps data", async () => {
    const store = memoryStore({});
    const fetch = mockFetch((url, init) => {
      expect(url).toBe("https://qdit.test/api/v1/me");
      expect(bearer(init)).toBe("Bearer at1");
      return json(200, { data: ME });
    });
    expect(await createQditClient(ANA, { config, store, fetch, now: () => NOW }).me()).toEqual(ME);
  });

  it("pages projects and posts JSON bodies to the contract's paths", async () => {
    const store = memoryStore({});
    const calls: string[] = [];
    const fetch = mockFetch((url, init) => {
      calls.push(`${init.method} ${url} ${init.body ?? ""}`);
      if (url.includes("/projects?")) {
        return json(200, { data: [{ id: url.includes("cursor") ? "p2" : "p1" }], next_cursor: url.includes("cursor") ? null : "c1" });
      }
      if (init.method === "DELETE" && url.includes("/links/")) return new Response(null, { status: 204 });
      return json(200, { data: { ok: true } });
    });
    const client = createQditClient(ANA, { config, store, fetch, now: () => NOW });
    expect((await client.listAllProjects()).map((p) => p.id)).toEqual(["p1", "p2"]);
    await client.renameMilestone("m/1", "New title");
    await client.updateLink("l1", { node_id: "h5" });
    await client.deleteLink("l1");
    expect(calls).toEqual([
      "GET https://qdit.test/api/v1/projects?limit=100 ",
      "GET https://qdit.test/api/v1/projects?limit=100&cursor=c1 ",
      'PATCH https://qdit.test/api/v1/milestones/m%2F1 {"title":"New title"}',
      'PATCH https://qdit.test/api/v1/links/l1 {"node_id":"h5"}',
      "DELETE https://qdit.test/api/v1/links/l1 ",
    ]);
  });
});

describe("refresh", () => {
  it("refreshes an access token about to expire, before the call", async () => {
    const store = memoryStore({ expiresAt: NOW + 30_000 });
    const fetch = mockFetch((url, init) => {
      if (url === TOKEN_URL) return tokenResponse(2);
      expect(bearer(init)).toBe("Bearer at2");
      return json(200, { data: ME });
    });
    await createQditClient(ANA, { config, store, fetch, now: () => NOW }).me();
    expect(store.row()).toMatchObject({ accessToken: "at2", refreshToken: "rt2", generation: 2, status: "connected" });
  });

  it("refreshes once on a 401 and retries once", async () => {
    const store = memoryStore({});
    const fetch = mockFetch((url, init) => {
      if (url === TOKEN_URL) return tokenResponse(2);
      return bearer(init) === "Bearer at1" ? json(401, { error: { code: "unauthorized", message: "expired", details: null } }) : json(200, { data: ME });
    });
    await createQditClient(ANA, { config, store, fetch, now: () => NOW }).me();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reports a second 401 as unauthorized without touching the connection", async () => {
    const store = memoryStore({});
    const fetch = mockFetch((url) => (url === TOKEN_URL ? tokenResponse(2) : json(401, { error: { code: "unauthorized", message: "no", details: null } })));
    const error = await createQditClient(ANA, { config, store, fetch, now: () => NOW }).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QditError);
    expect((error as QditError).kind).toBe("unauthorized");
    expect(store.row()?.status).toBe("connected");
  });

  it("is single-flight: concurrent calls share one refresh", async () => {
    const store = memoryStore({ expiresAt: NOW - 1 });
    let refreshes = 0;
    const fetch = mockFetch(async (url) => {
      if (url === TOKEN_URL) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return tokenResponse(2);
      }
      return json(200, url.includes("/projects") ? { data: [], next_cursor: null } : { data: ME });
    });
    const client = createQditClient(ANA, { config, store, fetch, now: () => NOW });
    const other = createQditClient(ANA, { config, store, fetch, now: () => NOW });
    await Promise.all([client.me(), client.me(), other.me(), client.listProjects()]);
    expect(refreshes).toBe(1);
    expect(store.saveRefreshed).toHaveBeenCalledTimes(1);
  });

  it("marks the connection needs_reconnect when qdit refuses the refresh token", async () => {
    const store = memoryStore({ expiresAt: NOW - 1 });
    const fetch = mockFetch((url) => (url === TOKEN_URL ? json(400, { error: "invalid_grant" }) : json(200, { data: ME })));
    const error = await createQditClient(ANA, { config, store, fetch, now: () => NOW }).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QditNotConnectedError);
    expect((error as QditNotConnectedError).connection).toBe("needs_reconnect");
    expect(store.row()).toMatchObject({ status: "needs_reconnect", accessToken: null, refreshToken: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the tokens another instance stored when its own refresh token was already rotated", async () => {
    const store = memoryStore({ expiresAt: NOW - 1 });
    const fetch = mockFetch((url, init) => {
      if (url === TOKEN_URL) {
        // Another server instance refreshed first.
        store.set({ generation: 2, accessToken: "at9", refreshToken: "rt9", expiresAt: NOW + 3600_000 });
        return json(400, { error: "invalid_grant" });
      }
      expect(bearer(init)).toBe("Bearer at9");
      return json(200, { data: ME });
    });
    await createQditClient(ANA, { config, store, fetch, now: () => NOW }).me();
    expect(store.row()?.status).toBe("connected");
    expect(store.markStatus).not.toHaveBeenCalled();
  });

  it("keeps the connection when the auth server is down or doqtri's credentials are refused", async () => {
    for (const answer of [json(503, {}), json(401, { error: "invalid_client" })]) {
      const store = memoryStore({ expiresAt: NOW - 1 });
      const fetch = mockFetch((url) => (url === TOKEN_URL ? answer.clone() : json(200, { data: ME })));
      const error = await createQditClient(ANA, { config, store, fetch, now: () => NOW }).me().catch((e: unknown) => e);
      expect(["unavailable", "not_configured"]).toContain((error as QditError).kind);
      expect(store.row()?.status).toBe("connected");
    }
  });

  it("throws NotConnected without calling qdit when there is no usable connection", async () => {
    for (const [row, expected] of [
      [null, "none"],
      [{ status: "needs_reconnect", accessToken: null, refreshToken: null }, "needs_reconnect"],
      [{ status: "revoked", accessToken: null, refreshToken: null }, "revoked"],
      // Ciphertext that no longer decrypts (the key changed).
      [{ accessToken: null }, "needs_reconnect"],
    ] as const) {
      const fetch = mockFetch(() => json(200, { data: ME }));
      const error = await createQditClient(ANA, { config, store: memoryStore(row), fetch, now: () => NOW })
        .me()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QditNotConnectedError);
      expect((error as QditNotConnectedError).connection).toBe(expected);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});

describe("error mapping", () => {
  const body = (code: string, details: unknown = null) => ({ error: { code, message: `qdit says ${code}`, details } });

  it.each([
    [400, "invalid_request", "invalid_request"],
    [401, "unauthorized", "unauthorized"],
    [403, "forbidden", "forbidden"],
    [404, "not_found", "not_found"],
    [409, "conflict", "conflict"],
    [429, "rate_limited", "rate_limited"],
    [500, "internal_error", "server"],
    [502, "internal_error", "server"],
    [503, "unavailable", "unavailable"],
    [418, "teapot", "bad_response"],
  ])("%i %s -> %s", async (status, code, kind) => {
    const error = await errorFromResponse(json(status, body(code), { "X-Request-Id": "req-1" }));
    expect(error).toMatchObject({ kind, status, code, requestId: "req-1", message: `qdit says ${code}` });
  });

  it("carries details.reason for conflicts", async () => {
    const error = await errorFromResponse(
      json(409, body("conflict", { reason: "node_already_linked", milestone_id: "m1" })),
    );
    expect(error.reason).toBe("node_already_linked");
    expect(error.details).toEqual({ reason: "node_already_linked", milestone_id: "m1" });
  });

  it("reads Retry-After on 429 and 503, as seconds or a date", async () => {
    expect((await errorFromResponse(json(429, body("rate_limited"), { "Retry-After": "17" }))).retryAfterSeconds).toBe(17);
    expect((await errorFromResponse(json(503, body("unavailable"), { "Retry-After": "3" }))).retryAfterSeconds).toBe(3);
    expect(parseRetryAfter(new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5);
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("survives a body that is not the contract's", async () => {
    const error = await errorFromResponse(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(error).toMatchObject({ kind: "server", code: null, reason: null, message: "qdit answered 502" });
  });

  it("surfaces typed errors from client calls", async () => {
    const store = memoryStore({});
    const fetch = mockFetch(() => json(429, body("rate_limited"), { "Retry-After": "30" }));
    const error = await createQditClient(ANA, { config, store, fetch, now: () => NOW }).getMilestone("m1").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 30 });
  });

  it("times out a request that hangs, and names a network failure", async () => {
    const store = memoryStore({});
    const hang = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const timedOut = await createQditClient(ANA, { config, store, fetch: hang, timeoutMs: 20, now: () => NOW })
      .me()
      .catch((e: unknown) => e);
    expect((timedOut as QditError).kind).toBe("timeout");

    const down = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const failed = await createQditClient(ANA, { config, store, fetch: down, now: () => NOW }).me().catch((e: unknown) => e);
    expect((failed as QditError).kind).toBe("network");
  });

  it("refuses a success without data", async () => {
    const store = memoryStore({});
    const fetch = mockFetch(() => json(200, { nope: true }));
    const error = await createQditClient(ANA, { config, store, fetch, now: () => NOW }).me().catch((e: unknown) => e);
    expect((error as QditError).kind).toBe("bad_response");
  });
});
