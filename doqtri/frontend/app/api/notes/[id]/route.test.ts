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
/** Rows a table answers on its next single-row reads, before falling back to adminRows. */
const adminReads: Record<string, unknown[]> = {};
/** What a list read of a table answers (the workspace's titles). */
const adminLists: Record<string, unknown[]> = {};
const adminWrites: string[] = [];
/** Every UPDATE the service role sent: the columns it set and the filters it was conditional on. */
const adminUpdates: { table: string; changes: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
/** How the next UPDATE ... RETURNING answers; by default it matches and bumps a changed text's version. */
const updateAnswers: RpcResult[] = [];

function adminQuery(table: string) {
  let mode: "select" | "update" | "delete" | null = null;
  const filters: Record<string, unknown> = {};
  let changes: Record<string, unknown> = {};
  const query = {
    select: () => {
      mode ??= "select";
      return query;
    },
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return query;
    },
    neq: () => query,
    maybeSingle: async (): Promise<RpcResult> => {
      if (mode === "update") {
        const answer = updateAnswers.shift();
        if (answer) return answer;
        const base = Number(filters.version ?? 1);
        return { data: { version: "markdown" in changes ? base + 1 : base }, error: null };
      }
      const queued = adminReads[table];
      if (queued?.length) return { data: queued.shift(), error: null };
      return { data: adminRows[table] ?? null, error: null };
    },
    then: (resolve: (result: RpcResult) => unknown) =>
      resolve({ data: mode === "select" ? (adminLists[table] ?? []) : null, error: null }),
    update: (next: Record<string, unknown>) => {
      mode = "update";
      changes = next;
      adminWrites.push(`update ${table}`);
      adminUpdates.push({ table, changes: next, filters });
      return query;
    },
    delete: () => {
      mode = "delete";
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

const saveHook = vi.hoisted(() => ({
  noteBeforeSave: vi.fn(async () => null as unknown),
  afterNoteSaved: vi.fn(async () => undefined),
}));
vi.mock("@/lib/integrations/qdit-save-hook", () => saveHook);

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
  adminUpdates.length = 0;
  updateAnswers.length = 0;
  saveHook.afterNoteSaved.mockClear();
  for (const store of [adminRows, adminReads, adminLists]) {
    for (const key of Object.keys(store)) delete store[key];
  }
  adminRows.documents = { id: DOC, workspace_id: WS, user_id: ME, title: "Roadmap", markdown: "Body.\n", version: 3 };
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

  it("hands a successful save to the qdit link hook (WP-2.5), with the text it replaced", async () => {
    const before = { title: "Roadmap", markdown: "# v3", version: 3 };
    saveHook.noteBeforeSave.mockResolvedValueOnce(before);
    session.rpc.mockResolvedValue({ data: 4, error: null });
    await PUT(put({ markdown: "# v4", version: 3, session: TAB }), ctx());
    expect(saveHook.afterNoteSaved).toHaveBeenCalledWith({
      userId: ME,
      docId: DOC,
      baseVersion: 3,
      savedVersion: 4,
      markdown: "# v4",
      before,
    });
  });

  it("does not call the hook for a refused save", async () => {
    saveHook.afterNoteSaved.mockClear();
    session.rpc.mockResolvedValue({ data: null, error: { code: "DQVER", message: "stale", details: "5" } });
    await PUT(put({ markdown: "# v4", version: 3, session: TAB }), ctx());
    expect(saveHook.afterNoteSaved).not.toHaveBeenCalled();
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

describe("delete while someone else is editing", () => {
  const live = () => new Date(Date.now() - 60_000).toISOString();

  it("refuses a delete while another member holds the lock, before asking the ledger", async () => {
    adminRows.doc_locks = { holder: ANA, heartbeat_at: live() };
    const res = await DELETE(new Request(`http://localhost/api/notes/${DOC}`, { method: "DELETE" }), ctx());
    expect(res.status).toBe(423);
    expect(readDocument).not.toHaveBeenCalled();
    expect(adminWrites).toEqual([]);
  });
});

/*
 * PATCH writes through rename_document() (20261109100000_rename_document.sql)
 * as the caller, with no text (D-121). The lock, role and unique-title rules
 * are the function's, and backend/tests/rename_document.test.sql covers every
 * branch of them against a real database. These tests stub the function: they
 * check what the route sends it, and how each of its answers reaches the
 * client.
 */
describe("PATCH /api/notes/[id] renames the title alone (D-121)", () => {
  const TEXT = "# Roadmap\r\n\r\n## Scope\r\nKeep  this   spacing.\r\n";

  function rename(title: string, extra: Record<string, unknown> = {}) {
    return new Request(`http://localhost/api/notes/${DOC}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, ...extra }),
    });
  }

  /** The arguments of every rename_document() call. */
  const renameCalls = () =>
    session.rpc.mock.calls.filter(([fn]) => fn === "rename_document").map(([, args]) => args);

  /** Answers rename_document() in turn with `answers`; past them, as the real function does when every check passes. */
  function renameAnswers(...answers: RpcResult[]) {
    session.rpc.mockImplementation(async (fn) => {
      if (fn !== "rename_document") return { data: null, error: { message: `unexpected ${fn}` } };
      return answers.shift() ?? { data: 3, error: null };
    });
  }

  beforeEach(() => {
    adminRows.documents = { id: DOC, workspace_id: WS, user_id: ME, title: "Roadmap", markdown: TEXT, version: 3 };
    renameAnswers();
  });

  it("sends the title and no text, version or session, and answers the rename", async () => {
    const res = await PATCH(rename("Plan 2027"), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: DOC, title: "Plan 2027", previousTitle: "Roadmap" });
    expect(renameCalls()).toEqual([
      { p_document_id: DOC, p_title: "Plan 2027", p_markdown: null, p_base_version: null, p_session: null },
    ]);
    // The service role writes nothing: the function does, as the caller.
    expect(adminWrites).toEqual([]);
    // Not an edit: nothing runs as after a save.
    expect(saveHook.afterNoteSaved).not.toHaveBeenCalled();
  });

  it("leaves a first line that says the old title alone, as any other text", async () => {
    for (const markdown of [TEXT, "# \n\n## Scope\n", "Intro\n# Roadmap\n", "No heading at all.\n"]) {
      session.rpc.mockClear();
      adminRows.documents = { id: DOC, workspace_id: WS, user_id: ME, title: "Roadmap", markdown, version: 3 };
      const res = await PATCH(rename("Plan 2027"), ctx());
      expect(res.status).toBe(200);
      expect(renameCalls()).toEqual([expect.objectContaining({ p_markdown: null })]);
    }
  });

  it("ignores a session or expected title sent by an older client", async () => {
    const res = await PATCH(rename("Plan 2027", { session: "tab-1", expectedTitle: "Something else" }), ctx());
    expect(res.status).toBe(200);
    expect(renameCalls()).toEqual([expect.objectContaining({ p_title: "Plan 2027", p_session: null })]);
  });

  it("refuses a title another note has before calling anything", async () => {
    adminLists.documents = [{ title: " plan 2027 " }];
    const res = await PATCH(rename("Plan 2027"), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Another note is already called “Plan 2027”", code: "TITLE_TAKEN" });
    expect(renameCalls()).toEqual([]);
  });

  it("answers 409 TITLE_TAKEN when a teammate took the title first (the function's unique violation)", async () => {
    renameAnswers({ data: null, error: { code: "23505", message: "duplicate key value" } });
    const res = await PATCH(rename("Plan 2027"), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TITLE_TAKEN");
  });

  it("answers 423 LOCKED when another member holds the lock", async () => {
    renameAnswers({ data: null, error: { code: "DQLCK", message: "someone else is editing this note", details: "other" } });
    const res = await PATCH(rename("Plan 2027"), ctx());
    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ code: "LOCKED", error: "Someone else is editing this note. Try again when they are done." });
  });

  it("refuses a viewer before calling anything, and maps the function's own role refusal", async () => {
    adminRows.workspace_members = { role: "viewer" };
    expect((await PATCH(rename("Plan 2027"), ctx())).status).toBe(403);
    expect(renameCalls()).toEqual([]);

    adminRows.workspace_members = { role: "editor" };
    renameAnswers({ data: null, error: { code: "42501", message: "you can read this note but not rename it" } });
    expect((await PATCH(rename("Plan 2027"), ctx())).status).toBe(403);
    renameAnswers({ data: null, error: { code: "P0002", message: "note not found" } });
    expect((await PATCH(rename("Plan 2027"), ctx())).status).toBe(404);
  });

  it("calls nothing when the title does not change", async () => {
    const res = await PATCH(rename("  Roadmap "), ctx());
    expect(res.status).toBe(200);
    expect(renameCalls()).toEqual([]);
  });

  it("refuses an empty title", async () => {
    const res = await PATCH(rename("   "), ctx());
    expect(res.status).toBe(400);
    expect(renameCalls()).toEqual([]);
  });

  it("refuses a title with a line break or other control character (400), calling nothing", async () => {
    for (const title of ["New\n## Injected", "New\r## X", "Tab\there", "Bell\u0007", "Del\u007f"]) {
      const res = await PATCH(rename(title), ctx());
      expect(res.status, JSON.stringify(title)).toBe(400);
      expect((await res.json()).code).toBe("BAD_TITLE");
    }
    expect(renameCalls()).toEqual([]);
  });

  it("maps the function's own one-line refusal to the same 400", async () => {
    renameAnswers({ data: null, error: { code: "23514", message: "a note's title is one line of text" } });
    const res = await PATCH(rename("Plan 2027"), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("BAD_TITLE");
  });
});

describe("deleting a note linked to qdit (WP-2.5)", () => {
  it("refuses until an admin unlinks the project, before asking the ledger", async () => {
    adminRows.doc_project_links = { project_name: "Soroban payroll" };
    const res = await DELETE(new Request(`http://localhost/api/notes/${DOC}`, { method: "DELETE" }), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("QDIT_LINKED");
    expect(body.error).toContain("Soroban payroll");
    expect(readDocument).not.toHaveBeenCalled();
    expect(adminWrites).toEqual([]);
  });

  it("does not point at the ship panel while the integration is off", async () => {
    adminRows.doc_project_links = { project_name: "Soroban payroll" };
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    const off = await (await DELETE(new Request(`http://localhost/api/notes/${DOC}`, { method: "DELETE" }), ctx())).json();
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
    const on = await (await DELETE(new Request(`http://localhost/api/notes/${DOC}`, { method: "DELETE" }), ctx())).json();
    vi.unstubAllEnvs();
    expect(off).toMatchObject({ code: "QDIT_LINKED" });
    expect(off.error).toContain("turned off");
    expect(off.error).not.toContain("ship panel");
    expect(on.error).toContain("ship panel");
  });

  it("deletes an unlinked note as before", async () => {
    readDocument.mockResolvedValue(null);
    const res = await DELETE(new Request(`http://localhost/api/notes/${DOC}`, { method: "DELETE" }), ctx());
    expect(res.status).toBe(200);
    expect(adminWrites).toEqual(["delete documents"]);
  });
});
