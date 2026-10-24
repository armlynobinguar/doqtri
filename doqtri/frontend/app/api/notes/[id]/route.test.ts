import { beforeEach, describe, expect, it, vi } from "vitest";

const DOC = "30000000-0000-4000-8000-000000000010";
const WS = "10000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-000000000003";
const ANA = "00000000-0000-4000-8000-000000000006";
const TAB = "a0000000-0000-4000-8000-000000000003";

type DbError = { code?: string; message?: string; details?: string };
type RpcResult = { data: unknown; error: DbError | null };

const session = {
  user: { id: ME } as { id: string } | null,
  rpc: vi.fn<(fn: string, args: Record<string, unknown>) => Promise<RpcResult>>(),
};

/** What the service role reads, per table, for the lock checks before a rename or delete. */
const adminRows: Record<string, unknown> = {};
const adminWrites: string[] = [];

function adminQuery(table: string) {
  const query = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    maybeSingle: async () => ({ data: adminRows[table] ?? null, error: null }),
    update: () => {
      adminWrites.push(`update ${table}`);
      return query;
    },
    delete: () => {
      adminWrites.push(`delete ${table}`);
      return query;
    },
  };
  return query;
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.user } }) },
    rpc: session.rpc,
  }),
  createSupabaseAdminClient: () => ({ from: adminQuery }),
}));

const readDocument = vi.fn();
vi.mock("@/lib/stellar/contract-client", () => ({
  DoqtriRegistry: { readDocument: (...args: unknown[]) => readDocument(...args) },
}));

const { PUT, PATCH, DELETE } = await import("./route");

function ctx(id = DOC) {
  return { params: Promise.resolve({ id }) } as RouteContext<"/api/notes/[id]">;
}

function put(body: unknown) {
  return new Request(`http://localhost/api/notes/${DOC}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  session.user = { id: ME };
  session.rpc.mockReset();
  readDocument.mockReset();
  adminWrites.length = 0;
  for (const key of Object.keys(adminRows)) delete adminRows[key];
  adminRows.documents = { id: DOC, workspace_id: WS, user_id: ME, title: "Roadmap" };
  adminRows.workspace_members = { role: "editor" };
});

describe("PUT /api/notes/[id] (save)", () => {
  it("refuses a signed-out caller", async () => {
    session.user = null;
    const res = await PUT(put({ markdown: "# a", version: 1, session: TAB }), ctx());
    expect(res.status).toBe(401);
    expect(session.rpc).not.toHaveBeenCalled();
  });

  it("needs the markdown, the version it is based on and the editor's session", async () => {
    for (const body of [
      { markdown: "# a", session: TAB },
      { version: 1, session: TAB },
      { markdown: 1, version: 1, session: TAB },
      { markdown: "# a", version: 0, session: TAB },
      { markdown: "# a", version: 1.5, session: TAB },
      { markdown: "# a", version: 1 },
      { markdown: "# a", version: 1, session: "tab-1" },
      "not json",
    ]) {
      const res = await PUT(put(body), ctx());
      expect(res.status).toBe(400);
    }
    expect(session.rpc).not.toHaveBeenCalled();
  });

  it("saves through save_document as the caller and returns the new version", async () => {
    session.rpc.mockResolvedValue({ data: 4, error: null });
    const res = await PUT(put({ markdown: "# v4", version: 3, session: TAB }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: DOC, version: 4 });
    expect(session.rpc).toHaveBeenCalledWith("save_document", {
      p_document_id: DOC,
      p_markdown: "# v4",
      p_base_version: 3,
      p_session: TAB,
    });
    // The service role never writes the text.
    expect(adminWrites).toEqual([]);
  });

  it("answers 423 naming the holder when the caller does not hold the lock", async () => {
    session.rpc.mockImplementation(async (fn) => {
      if (fn === "save_document") {
        return { data: null, error: { code: "DQLCK", message: "you are not holding the edit lock on this note" } };
      }
      return {
        data: {
          document_id: DOC,
          holder: ANA,
          holder_name: "ana",
          mine: false,
          can_edit: true,
          can_take_over: false,
          version: 3,
        },
        error: null,
      };
    });
    const res = await PUT(put({ markdown: "# mine", version: 3, session: TAB }), ctx());
    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body).toMatchObject({ code: "NOT_LOCK_HOLDER", error: "ana is editing this note" });
    expect(body.lock).toMatchObject({ holder: ANA, mine: false });
    expect(session.rpc).toHaveBeenCalledWith("doc_lock_status_for", { p_document_id: DOC, p_session: TAB });
  });

  it("says so when the caller holds the lock from another tab", async () => {
    session.rpc.mockImplementation(async (fn) => {
      if (fn === "save_document") {
        return { data: null, error: { code: "DQLCK", message: "you are not holding the edit lock on this note" } };
      }
      return {
        data: { document_id: DOC, holder: ME, holder_name: "editor", mine: false, mine_elsewhere: true, version: 3 },
        error: null,
      };
    });
    const res = await PUT(put({ markdown: "# tab b", version: 3, session: TAB }), ctx());
    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body.error).toMatch(/another tab/);
    expect(body.lock).toMatchObject({ mineElsewhere: true });
  });

  it("answers 409 with the current version when the copy is stale", async () => {
    session.rpc.mockResolvedValue({
      data: null,
      error: { code: "DQVER", message: "this note was saved elsewhere", details: "5" },
    });
    const res = await PUT(put({ markdown: "# old", version: 3, session: TAB }), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "STALE_VERSION", version: 5 });
  });

  it("answers 403 for a viewer and 404 for a note the caller cannot see", async () => {
    session.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "you can read this note but not edit it" },
    });
    expect((await PUT(put({ markdown: "x", version: 1, session: TAB }), ctx())).status).toBe(403);
    session.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "note not found" } });
    expect((await PUT(put({ markdown: "x", version: 1, session: TAB }), ctx())).status).toBe(404);
  });
});

describe("rename and delete while someone else is editing", () => {
  const live = () => new Date(Date.now() - 60_000).toISOString();
  const lapsed = () => new Date(Date.now() - 11 * 60_000).toISOString();

  function patch(title: string) {
    return new Request(`http://localhost/api/notes/${DOC}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
  }

  it("refuses a rename while another member holds the lock", async () => {
    adminRows.doc_locks = { holder: ANA, heartbeat_at: live() };
    const res = await PATCH(patch("Roadmap 2027"), ctx());
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe("LOCKED");
    expect(adminWrites).toEqual([]);
  });

  it("lets the lock holder rename", async () => {
    adminRows.doc_locks = { holder: ME, heartbeat_at: live() };
    const res = await PATCH(patch("Roadmap 2027"), ctx());
    expect(res.status).toBe(200);
    expect(adminWrites).toEqual(["update documents"]);
  });

  it("ignores a lapsed lock", async () => {
    adminRows.doc_locks = { holder: ANA, heartbeat_at: lapsed() };
    const res = await PATCH(patch("Roadmap 2027"), ctx());
    expect(res.status).toBe(200);
  });

  it("refuses a delete while another member holds the lock, before asking the ledger", async () => {
    adminRows.doc_locks = { holder: ANA, heartbeat_at: live() };
    const res = await DELETE(new Request(`http://localhost/api/notes/${DOC}`, { method: "DELETE" }), ctx());
    expect(res.status).toBe(423);
    expect(readDocument).not.toHaveBeenCalled();
    expect(adminWrites).toEqual([]);
  });
});
