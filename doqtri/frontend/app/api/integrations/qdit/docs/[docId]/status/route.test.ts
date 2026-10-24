import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/lib/workspace-roles";

/*
 * The panel's re-check route (WP-2.8, R-09): any member may ask, only an
 * editor may force fresh reads, and the user's qdit client and the chain
 * reader are what recheckDocStatuses (tested on its own) is handed.
 */

const DOC = "30000000-0000-4000-8000-000000000010";
let role: WorkspaceRole | null = "viewer";
let user: { id: string } | null = { id: "00000000-0000-4000-8000-000000000003" };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
  createSupabaseAdminClient: () => ({}),
}));
vi.mock("@/lib/workspace-docs", () => ({
  loadMemberDocument: async () =>
    role
      ? { ok: true, role, doc: { id: DOC, workspace_id: "ws", title: "Plan", markdown: "# A" } }
      : { ok: false, reason: "not_found" },
}));
vi.mock("@/lib/stellar/contract-client", () => ({ DoqtriRegistry: { getDocument: async () => null } }));
const qditClient = { me: vi.fn() };
vi.mock("@/lib/integrations/qdit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-client")>()),
  qditServerSetup: () => ({ config: {}, tokenKey: Buffer.alloc(32), store: {} }),
  createQditClient: () => qditClient,
}));
const recheck = vi.fn(async () => ({ states: { m: { chain_status: "Approved" } }, errors: [] }));
vi.mock("@/lib/integrations/qdit-status-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-status-sync")>()),
  recheckDocStatuses: (...args: unknown[]) => recheck(...(args as [])),
}));

const { POST } = await import("./route");
const call = (body?: unknown, docId = DOC) =>
  POST(
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ docId }) } as never,
  );

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
  role = "viewer";
  user = { id: "00000000-0000-4000-8000-000000000003" };
  recheck.mockClear();
});

describe("POST /api/integrations/qdit/docs/[docId]/status", () => {
  it("lets a viewer see the states, with the user's client and the chain reader", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ states: { m: { chain_status: "Approved" } }, errors: [] });
    expect(recheck).toHaveBeenCalledWith(expect.objectContaining({ docId: DOC, client: qditClient, force: false }));
  });

  it("forces fresh reads for an editor only", async () => {
    await call({ force: true });
    expect(recheck).toHaveBeenLastCalledWith(expect.objectContaining({ force: false }));
    role = "editor";
    await call({ force: true });
    expect(recheck).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
  });

  it("is off with the integration off, and closed to non-members and the signed out", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    expect((await call()).status).toBe(404);
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
    role = null;
    expect((await call()).status).toBe(404);
    user = null;
    expect((await call()).status).toBe(401);
    expect(recheck).not.toHaveBeenCalled();
  });
});
