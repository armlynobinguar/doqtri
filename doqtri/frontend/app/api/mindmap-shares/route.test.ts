import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/lib/workspace-roles";

/*
 * GET /api/mindmap-shares and POST /api/mindmap-shares/{id}/revoke (WP-4.7,
 * DOQ-53): admins list and revoke their workspace's links with their own
 * session (RLS on mindmap_shares is tested in
 * backend/tests/mindmap_shares.test.sql); below admin is refused before any
 * read, and anything the session cannot revoke reads as 404.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const WS = "10000000-0000-4000-8000-000000000001";
const ID = "40000000-0000-4000-8000-000000000001";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

let user: { id: string } | null = { id: ME };
let role: WorkspaceRole = "admin";
let rows: { id: string; token: string; created_at: string; expires_at: string | null }[] = [];
let updated: { id: string }[] = [];
const calls: [string, ...unknown[]][] = [];

function query() {
  const q = {
    select: (...a: unknown[]) => (calls.push(["select", ...a]), q),
    eq: (...a: unknown[]) => (calls.push(["eq", ...a]), q),
    is: (...a: unknown[]) => (calls.push(["is", ...a]), q),
    or: (...a: unknown[]) => (calls.push(["or", ...a]), q),
    order: (...a: unknown[]) => (calls.push(["order", ...a]), q),
    limit: async (...a: unknown[]) => (calls.push(["limit", ...a]), { data: rows, error: null }),
    update: (...a: unknown[]) => {
      calls.push(["update", ...a]);
      const u = {
        eq: (...b: unknown[]) => (calls.push(["eq", ...b]), u),
        is: (...b: unknown[]) => (calls.push(["is", ...b]), u),
        select: async (...b: unknown[]) => (calls.push(["select", ...b]), { data: updated, error: null }),
      };
      return u;
    },
  };
  return q;
}

const sessionClient = {
  auth: { getUser: async () => ({ data: { user } }) },
  from: (table: string) => (calls.push(["from", table]), query()),
};
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => sessionClient,
  createSupabaseAdminClient: () => {
    throw new Error("never the service role here");
  },
}));
vi.mock("@/lib/active-workspace", () => ({
  readActiveWorkspaceCookie: async () => WS,
  resolveActiveWorkspace: async () => ({ active: { id: WS, name: "Team", personal: false, role, mine: false }, workspaces: [] }),
}));
vi.mock("@/lib/site-url", () => ({ SITE_URL: "https://doqtri.test" }));

const { GET } = await import("./route");
const { POST } = await import("./[id]/revoke/route");
const { MINDMAP_SHARE_COPY: COPY } = await import("@/lib/mindmap-share");

const revoke = (id: string) =>
  POST(new Request(`http://localhost/api/mindmap-shares/${id}/revoke`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  user = { id: ME };
  role = "admin";
  rows = [{ id: ID, token: TOKEN, created_at: "2026-11-12T09:00:00Z", expires_at: null }];
  updated = [{ id: ID }];
  calls.length = 0;
});

describe("GET /api/mindmap-shares", () => {
  it("lists the active workspace's live links, newest first, as links, each with its expiry (DOQ-54)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T10:00:00.000Z"));
    rows.push({ id: "40000000-0000-4000-8000-000000000002", token: `${TOKEN}b`, created_at: "2026-11-11T09:00:00Z", expires_at: "2026-11-21T08:00:00+00:00" });
    const res = await GET();
    vi.useRealTimers();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      shares: [
        { id: ID, url: `https://doqtri.test/m/${TOKEN}`, created_at: "2026-11-12T09:00:00Z", expires_at: null },
        {
          id: "40000000-0000-4000-8000-000000000002",
          url: `https://doqtri.test/m/${TOKEN}b`,
          created_at: "2026-11-11T09:00:00Z",
          expires_at: "2026-11-21T08:00:00+00:00",
        },
      ],
    });
    expect(calls).toEqual([
      ["from", "mindmap_shares"],
      ["select", "id, token, created_at, expires_at"],
      ["eq", "workspace_id", WS],
      ["is", "revoked_at", null],
      // Expired links are left out like revoked ones.
      ["or", "expires_at.is.null,expires_at.gt.2026-11-20T10:00:00.000Z"],
      ["order", "created_at", { ascending: false }],
      ["limit", 50],
    ]);
  });

  it("needs a signed-in user", async () => {
    user = null;
    expect((await GET()).status).toBe(401);
  });

  it.each(["viewer", "editor"] as const)("refuses a workspace %s before reading anything", async (r) => {
    role = r;
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, code: "FORBIDDEN", message: COPY.forbidden });
    expect(calls).toEqual([]);
  });
});

describe("POST /api/mindmap-shares/{id}/revoke", () => {
  it("revokes with the session, only a link not revoked yet", async () => {
    const res = await revoke(ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([
      ["from", "mindmap_shares"],
      ["update", { revoked_at: expect.any(String) }],
      ["eq", "id", ID],
      ["is", "revoked_at", null],
      ["select", "id"],
    ]);
  });

  it("is 404 when RLS let nothing change: not an admin of it, unknown, or already revoked", async () => {
    updated = [];
    const res = await revoke(ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, code: "NOT_FOUND", message: COPY.notFound });
  });

  it("is 404 for an id that is not a UUID, without asking", async () => {
    expect((await revoke("nope")).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("needs a signed-in user", async () => {
    user = null;
    expect((await revoke(ID)).status).toBe(401);
  });
});
