import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredConnection } from "@/lib/integrations/connection-store";

/*
 * GET /api/integrations/qdit/milestones/[id] (WP-2.6): the milestone card's
 * route. It reads qdit as the signed-in user with their own client, and
 * answers each of the card's states with a code the card branches on.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const MILESTONE_ID = "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61";

let user: { id: string } | null = { id: ME };
let configured = true;
let connection: StoredConnection | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
  createSupabaseAdminClient: () => ({}),
}));

const getMilestone = vi.fn();
const createQditClient = vi.fn<(userId: string, deps: unknown) => { getMilestone: typeof getMilestone }>(() => ({ getMilestone }));
const store = { load: vi.fn(async () => connection) };
vi.mock("@/lib/integrations/qdit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-client")>()),
  qditServerSetup: () => (configured ? { config: { apiBaseUrl: "https://qdit.test/api/v1" }, tokenKey: Buffer.alloc(32), store } : null),
  createQditClient: (userId: string, deps: unknown) => createQditClient(userId, deps),
}));

const { QditError } = await import("@/lib/integrations/qdit-client");
const { milestonePreviewCache } = await import("@/lib/integrations/qdit-milestone-preview");
const route = await import("./milestones/[id]/route");

const ctx = (id = MILESTONE_ID) => ({ params: Promise.resolve({ id }) }) as never;
const get = (id?: string) => route.GET(new Request("http://localhost/x"), ctx(id));

const MILESTONE = {
  id: MILESTONE_ID,
  project: { id: "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34", name: "Soroban payroll", slug: "soroban-payroll" },
  title: "Escrow contract",
  description: "internal notes",
  status: "submitted",
  due_date: "2026-11-15",
  order_index: 3,
  url: "https://qdit.app/projects/soroban-payroll/milestones",
  link: null,
  anchor: null,
  created_at: "2026-10-20T14:02:11.000Z",
  updated_at: "2026-10-22T08:11:40.000Z",
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
  user = { id: ME };
  configured = true;
  connection = {
    userId: ME,
    subject: "qdit-user-1",
    accountLabel: null,
    scopes: [],
    status: "connected",
    generation: 1,
    expiresAt: null,
    accessToken: "at",
    refreshToken: "rt",
  };
  milestonePreviewCache.clear();
  getMilestone.mockReset().mockResolvedValue(MILESTONE);
  createQditClient.mockClear();
  store.load.mockClear();
});

describe("GET /api/integrations/qdit/milestones/[id]", () => {
  it("is 404 with the integration off, and reads nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    expect((await get()).status).toBe(404);
    expect(store.load).not.toHaveBeenCalled();
    expect(getMilestone).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    user = null;
    expect((await get()).status).toBe(401);
    expect(getMilestone).not.toHaveBeenCalled();
  });

  it("is 503 when this deployment has no qdit", async () => {
    configured = false;
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("QDIT_NOT_CONFIGURED");
  });

  it("loaded: the card's fields only, read as the signed-in user, never stored by the browser", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.milestone).toMatchObject({ id: MILESTONE_ID, title: "Escrow contract", status: "submitted" });
    expect(JSON.stringify(body)).not.toContain("internal notes");
    expect(createQditClient).toHaveBeenCalledWith(ME, expect.objectContaining({ store }));
    expect(getMilestone).toHaveBeenCalledWith(MILESTONE_ID);
  });

  it("asks qdit with the id in lowercase canonical form", async () => {
    await get(MILESTONE_ID.toUpperCase());
    expect(getMilestone).toHaveBeenCalledWith(MILESTONE_ID);
  });

  it("serves a second card from the short cache", async () => {
    await get();
    const res = await get();
    expect(res.status).toBe(200);
    expect(getMilestone).toHaveBeenCalledTimes(1);
  });

  it("no-access: qdit's 404 and 403 give the same answer", async () => {
    for (const [kind, status] of [["not_found", 404], ["forbidden", 403]] as const) {
      milestonePreviewCache.clear();
      getMilestone.mockRejectedValueOnce(new QditError(kind, "qdit's own words", { status }));
      const res = await get();
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({ error: "You don't have access to this milestone in qdit", code: "QDIT_NO_ACCESS" });
    }
  });

  it("no-access for an id that is not a uuid, without asking qdit", async () => {
    const res = await get("../projects");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("QDIT_NO_ACCESS");
    expect(getMilestone).not.toHaveBeenCalled();
  });

  it("not-connected: never connected, or the connection lapsed", async () => {
    const lapsed = { ...connection!, status: "revoked" as const, accessToken: null, refreshToken: null };
    connection = null;
    let res = await get();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "QDIT_NOT_CONNECTED", connection: "none" });

    connection = lapsed;
    res = await get();
    expect(await res.json()).toMatchObject({ code: "QDIT_NOT_CONNECTED", connection: "needs_reconnect" });
    expect(getMilestone).not.toHaveBeenCalled();
  });

  it("not-connected when qdit still refuses the token after the refresh", async () => {
    getMilestone.mockRejectedValueOnce(new QditError("unauthorized", "x", { status: 401 }));
    const res = await get();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "QDIT_NOT_CONNECTED", connection: "needs_reconnect" });
  });

  it("a second 401 after the refresh marks the connection, so the next card fails fast (WP-2.6d)", async () => {
    const actual = await vi.importActual<typeof import("@/lib/integrations/qdit-client")>("@/lib/integrations/qdit-client");
    const refused = () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "no", details: null } }), { status: 401 });
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/oauth/token")
        ? new Response(JSON.stringify({ access_token: "at2", token_type: "bearer", expires_in: 3600, refresh_token: "rt2" }), {
            status: 200,
          })
        : refused(),
    );
    const marks: string[] = [];
    const memory = {
      load: async () => (connection ? { ...connection } : null),
      saveConnected: async () => ({ replaced: null }),
      saveRefreshed: async (_u: string, generation: number, tokens: { accessToken: string }) => {
        connection = { ...connection!, generation: generation + 1, accessToken: tokens.accessToken };
        return true;
      },
      markStatus: async (_u: string, generation: number, status: "needs_reconnect" | "revoked") => {
        marks.push(`${generation}:${status}`);
        connection = { ...connection!, status, generation: generation + 1, accessToken: null, refreshToken: null };
        return true;
      },
    };
    createQditClient.mockImplementation(
      (userId) =>
        actual.createQditClient(userId, {
        config: { apiBaseUrl: "https://qdit.test/api/v1", issuer: "https://auth.qdit.test/auth/v1", clientId: "c", clientSecret: "s", redirectUri: null, tokenKey: "", tokenKeyPrevious: null },
        store: memory,
        fetch,
      }) as unknown as { getMilestone: typeof getMilestone },
    );
    try {
      let res = await get();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "QDIT_NOT_CONNECTED", connection: "needs_reconnect" });
      expect(marks).toEqual(["2:needs_reconnect"]);
      expect(connection).toMatchObject({ status: "needs_reconnect", accessToken: null });
      // Request, refresh, retry: then nothing more.
      expect(fetch).toHaveBeenCalledTimes(3);

      res = await get();
      expect(await res.json()).toMatchObject({ code: "QDIT_NOT_CONNECTED", connection: "needs_reconnect" });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      createQditClient.mockImplementation(() => ({ getMilestone }));
    }
  });

  it("passes a rate limit on with Retry-After, and does not keep it", async () => {
    getMilestone.mockRejectedValueOnce(new QditError("rate_limited", "x", { status: 429, retryAfterSeconds: 7 }));
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect((await get()).status).toBe(200);
  });

  it("anything else from qdit is 502, without qdit's words", async () => {
    for (const kind of ["unavailable", "server", "timeout", "network", "bad_response"] as const) {
      getMilestone.mockRejectedValueOnce(new QditError(kind, "secret upstream detail"));
      const res = await get();
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.code).toBe("QDIT_UNAVAILABLE");
      expect(JSON.stringify(body)).not.toContain("secret upstream detail");
    }
  });

  it("refused client credentials are 503, not a reconnect prompt", async () => {
    getMilestone.mockRejectedValueOnce(new QditError("not_configured", "x"));
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("QDIT_NOT_CONFIGURED");
  });
});
