import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "00000000-0000-4000-8000-000000000003";
const PERSONAL = "10000000-0000-4000-8000-000000000001";
const TEAM = "10000000-0000-4000-8000-000000000002";

const session = { user: { id: ME } as { id: string } | null, cookie: undefined as string | undefined };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.user } }) },
  }),
  createSupabaseAdminClient: () => ({}),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session.cookie ? { value: session.cookie } : undefined) }),
}));

const workspaceForCreate = vi.fn();
vi.mock("@/lib/active-workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/active-workspace")>()),
  workspaceForCreate: (...args: unknown[]) => workspaceForCreate(...args),
}));

const insertWorkspaceDocument = vi.fn();
vi.mock("@/lib/workspace-docs", () => ({
  insertWorkspaceDocument: (...args: unknown[]) => insertWorkspaceDocument(...args),
  personalWorkspaceId: async () => PERSONAL,
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(new Request("https://doqtri.test/api/notes", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  session.user = { id: ME };
  session.cookie = undefined;
  workspaceForCreate.mockReset();
  insertWorkspaceDocument.mockReset();
  insertWorkspaceDocument.mockResolvedValue({ id: "doc-1", title: "Plan" });
});

describe("POST /api/notes", () => {
  it("creates the note in the workspace the request names (WP-1.7)", async () => {
    workspaceForCreate.mockResolvedValue({ ok: true, workspaceId: TEAM });
    session.cookie = `${ME}.${PERSONAL}`;
    const res = await post({ title: "Plan", workspaceId: TEAM });
    expect(res.status).toBe(200);
    expect(workspaceForCreate).toHaveBeenCalledWith(expect.anything(), ME, { requested: TEAM, cookie: PERSONAL });
    expect(insertWorkspaceDocument.mock.calls[0][1]).toMatchObject({ userId: ME, workspaceId: TEAM, title: "Plan" });
  });

  it("passes the active workspace cookie when the request names none", async () => {
    workspaceForCreate.mockResolvedValue({ ok: true, workspaceId: TEAM });
    session.cookie = `${ME}.${TEAM}`;
    await post({});
    expect(workspaceForCreate).toHaveBeenCalledWith(expect.anything(), ME, { requested: undefined, cookie: TEAM });
  });

  it("ignores a cookie another account left in this browser", async () => {
    workspaceForCreate.mockResolvedValue({ ok: true, workspaceId: PERSONAL });
    session.cookie = `00000000-0000-4000-8000-000000000099.${TEAM}`;
    await post({});
    expect(workspaceForCreate).toHaveBeenCalledWith(expect.anything(), ME, { requested: undefined, cookie: null });
  });

  it("refuses a viewer and creates nothing (D-14)", async () => {
    workspaceForCreate.mockResolvedValue({ ok: false, status: 403, error: "viewer" });
    const res = await post({ workspaceId: TEAM });
    expect(res.status).toBe(403);
    expect(insertWorkspaceDocument).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    session.user = null;
    expect((await post({})).status).toBe(401);
  });
});
