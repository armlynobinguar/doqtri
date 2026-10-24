import { beforeEach, describe, expect, it, vi } from "vitest";

const DOC = "30000000-0000-4000-8000-000000000010";
const ME = "00000000-0000-4000-8000-000000000003";
const TAB = "a0000000-0000-4000-8000-000000000003";

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

const session = {
  user: { id: ME } as { id: string } | null,
  rpc: vi.fn<(fn: string, args: Record<string, unknown>) => Promise<RpcResult>>(),
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.user } }) },
    rpc: session.rpc,
  }),
  createSupabaseAdminClient: () => {
    throw new Error("the lock route must not use the service role");
  },
}));

const { GET, POST, DELETE } = await import("./route");

function ctx(id = DOC) {
  return { params: Promise.resolve({ id }) } as RouteContext<"/api/notes/[id]/lock">;
}

function row(over: Record<string, unknown> = {}) {
  return {
    document_id: DOC,
    holder: ME,
    holder_name: "editor",
    acquired_at: "2026-10-24T10:00:00Z",
    heartbeat_at: "2026-10-24T10:00:00Z",
    expires_at: "2026-10-24T10:10:00Z",
    mine: true,
    can_edit: true,
    can_take_over: false,
    version: 2,
    ...over,
  };
}

/** A request from the editor's tab; `query` adds to its `session=`. */
const req = (method: string, query = "") =>
  new Request(`http://localhost/api/notes/${DOC}/lock?session=${TAB}${query}`, { method });
const bare = (method: string, query = "") =>
  new Request(`http://localhost/api/notes/${DOC}/lock${query}`, { method });

beforeEach(() => {
  session.user = { id: ME };
  session.rpc.mockReset();
});

describe("/api/notes/[id]/lock", () => {
  it("refuses a signed-out caller", async () => {
    session.user = null;
    for (const handler of [GET, POST, DELETE]) {
      const res = await handler(req("POST"), ctx());
      expect(res.status).toBe(401);
    }
    expect(session.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not a uuid, without asking the database", async () => {
    const res = await POST(req("POST"), ctx("nope"));
    expect(res.status).toBe(404);
    expect(session.rpc).not.toHaveBeenCalled();
  });

  it("GET returns the status", async () => {
    session.rpc.mockResolvedValue({ data: row({ mine: false, holder: null, holder_name: null }), error: null });
    const res = await GET(req("GET"), ctx());
    expect(res.status).toBe(200);
    expect(session.rpc).toHaveBeenCalledWith("doc_lock_status_for", { p_document_id: DOC, p_session: TAB });
    expect((await res.json()).lock).toMatchObject({ holder: null, version: 2 });
  });

  it("POST takes or renews the lock", async () => {
    session.rpc.mockResolvedValue({ data: row(), error: null });
    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(200);
    expect(session.rpc).toHaveBeenCalledWith("take_doc_lock", {
      p_document_id: DOC,
      p_session: TAB,
      p_takeover: false,
    });
    expect((await res.json()).lock).toMatchObject({ mine: true, holder: ME });
  });

  it("POST answers 423 with the holder when someone else is editing", async () => {
    session.rpc.mockResolvedValue({
      data: row({ mine: false, holder: "00000000-0000-4000-8000-000000000006", holder_name: "ana" }),
      error: null,
    });
    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body).toMatchObject({ code: "LOCKED", error: "ana is editing this note" });
    expect(body.lock).toMatchObject({ holderName: "ana", mine: false });
  });

  it("POST answers 423 LOCKED_ELSEWHERE when the caller is editing in another tab", async () => {
    session.rpc.mockResolvedValue({ data: row({ mine: false, mine_elsewhere: true }), error: null });
    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body).toMatchObject({ code: "LOCKED_ELSEWHERE" });
    expect(body.lock).toMatchObject({ mine: false, mineElsewhere: true });
  });

  it("POST and DELETE need the editor's session; nothing reaches the database without it", async () => {
    for (const handler of [POST, DELETE]) {
      const res = await handler(bare("POST"), ctx());
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("BAD_SESSION");
    }
    const bad = await POST(bare("POST", "?session=tab-1"), ctx());
    expect(bad.status).toBe(400);
    expect(session.rpc).not.toHaveBeenCalled();
  });

  it("GET without a session reads the status with none", async () => {
    session.rpc.mockResolvedValue({ data: row({ mine: false, mine_elsewhere: true }), error: null });
    const res = await GET(bare("GET"), ctx());
    expect(res.status).toBe(200);
    expect(session.rpc).toHaveBeenCalledWith("doc_lock_status_for", { p_document_id: DOC, p_session: null });
  });

  it("POST ?takeover=1 asks for a takeover", async () => {
    session.rpc.mockResolvedValue({ data: row({ can_take_over: true }), error: null });
    const res = await POST(req("POST", "&takeover=1"), ctx());
    expect(res.status).toBe(200);
    expect(session.rpc).toHaveBeenCalledWith("take_doc_lock", {
      p_document_id: DOC,
      p_session: TAB,
      p_takeover: true,
    });
  });

  it("POST ?takeover=1 by a non-admin is a 403", async () => {
    session.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "42501",
        message: "only an admin of the workspace can take over a note someone is editing",
      },
    });
    const res = await POST(req("POST", "&takeover=1"), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("TAKEOVER_FORBIDDEN");
  });

  it("POST by a viewer is a 403 READ_ONLY", async () => {
    session.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "you can read this note but not edit it" },
    });
    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("READ_ONLY");
  });

  it("POST on a note the caller cannot see is a 404", async () => {
    session.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "note not found" } });
    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(404);
  });

  it("a status the database did not shape is a 500", async () => {
    session.rpc.mockResolvedValue({ data: { nope: true }, error: null });
    const res = await POST(req("POST"), ctx());
    expect(res.status).toBe(500);
  });

  it("DELETE releases", async () => {
    session.rpc.mockResolvedValue({ data: true, error: null });
    const res = await DELETE(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(session.rpc).toHaveBeenCalledWith("release_doc_lock", { p_document_id: DOC, p_session: TAB });
    expect(await res.json()).toEqual({ released: true });
  });

  it("DELETE of a lock the caller does not hold is not an error", async () => {
    session.rpc.mockResolvedValue({ data: false, error: null });
    const res = await DELETE(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: false });
  });
});
