import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let signedIn = true;
const memberships = [
  { role: "owner", workspaces: { id: PERSONAL, name: "Ana", is_personal: true, created_by: USER } },
  { role: "viewer", workspaces: { id: TEAM, name: "Acme", is_personal: false, created_by: "someone" } },
];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: USER } : null } }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (r: unknown) => unknown) => resolve({ data: memberships, error: null }),
      };
      return chain;
    },
  }),
  createSupabaseAdminClient: () => ({}),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { GET, POST } from "./route";

const post = (body: unknown) =>
  POST(
    new NextRequest("https://doqtri.test/api/workspaces/active", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );

beforeEach(() => {
  signedIn = true;
});

describe("POST /api/workspaces/active", () => {
  it("remembers a workspace the user is a member of, keyed to them", async () => {
    const res = await post({ workspaceId: TEAM });
    expect(res.status).toBe(200);
    expect((await res.json()).workspace).toMatchObject({ id: TEAM, role: "viewer" });
    const cookie = res.cookies.get("doqtri_ws");
    expect(cookie?.value).toBe(`${USER}.${TEAM}`);
    expect(cookie?.httpOnly).toBe(true);
  });

  it("refuses a workspace the user is not in, and sets nothing", async () => {
    const res = await post({ workspaceId: STRANGER });
    expect(res.status).toBe(404);
    expect(res.cookies.get("doqtri_ws")).toBeUndefined();
  });

  it("refuses a malformed id", async () => {
    expect((await post({ workspaceId: "nope" })).status).toBe(404);
  });

  it("needs a session", async () => {
    signedIn = false;
    expect((await post({ workspaceId: TEAM })).status).toBe(401);
  });
});

describe("GET /api/workspaces/active", () => {
  const get = (query: string) => GET(new NextRequest(`https://doqtri.test/api/workspaces/active?${query}`));

  it("switches and sends the user on to the note", async () => {
    const res = await get(`ws=${TEAM}&next=${encodeURIComponent("/vault/abc")}`);
    expect(res.headers.get("location")).toBe("https://doqtri.test/vault/abc");
    expect(res.cookies.get("doqtri_ws")?.value).toBe(`${USER}.${TEAM}`);
  });

  it("never redirects off the vault", async () => {
    const res = await get(`ws=${TEAM}&next=${encodeURIComponent("https://evil.example/")}`);
    expect(res.headers.get("location")).toBe("https://doqtri.test/vault");
  });

  it("sends a non-member to the vault without switching", async () => {
    const res = await get(`ws=${STRANGER}&next=${encodeURIComponent("/vault/abc")}`);
    expect(res.headers.get("location")).toBe("https://doqtri.test/vault");
    expect(res.cookies.get("doqtri_ws")).toBeUndefined();
  });
});
