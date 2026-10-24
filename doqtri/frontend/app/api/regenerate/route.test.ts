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

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.user } }) },
    rpc: session.rpc,
  }),
  createSupabaseAdminClient: () => ({}),
}));

const loadMemberDocument = vi.fn();
const workspaceTitles = vi.fn();
vi.mock("@/lib/workspace-docs", () => ({
  loadMemberDocument: (...args: unknown[]) => loadMemberDocument(...args),
  workspaceTitles: (...args: unknown[]) => workspaceTitles(...args),
}));

const consumeAiQuota = vi.fn();
vi.mock("@/lib/ai-quota", () => ({
  consumeAiQuota: (...args: unknown[]) => consumeAiQuota(...args),
  quotaRefusal: () => new Response(JSON.stringify({ error: "quota" }), { status: 429 }),
}));

const improveMarkdown = vi.fn();
vi.mock("@/lib/openai", () => ({
  improveMarkdown: (...args: unknown[]) => improveMarkdown(...args),
}));

const generateAndStoreMindmap = vi.fn();
vi.mock("@/lib/mindmap-store", () => ({
  generateAndStoreMindmap: (...args: unknown[]) => generateAndStoreMindmap(...args),
}));

const { POST } = await import("./route");

function lockRow(over: Record<string, unknown> = {}) {
  return {
    document_id: DOC,
    holder: ME,
    holder_name: "editor",
    acquired_at: "2026-10-24T10:00:00Z",
    heartbeat_at: "2026-10-24T10:00:00Z",
    expires_at: "2026-10-24T10:10:00Z",
    mine: true,
    mine_elsewhere: false,
    can_edit: true,
    can_take_over: false,
    version: 3,
    ...over,
  };
}

function post(body: unknown) {
  return new Request("http://localhost/api/regenerate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The database answers: the lock as `take`, and the save as `save`. */
function database({ take = lockRow(), save = { data: 4, error: null } as RpcResult } = {}) {
  session.rpc.mockImplementation(async (fn) => {
    if (fn === "take_doc_lock") return { data: take, error: null };
    if (fn === "save_document") return save;
    throw new Error(`unexpected rpc ${fn}`);
  });
}

beforeEach(() => {
  session.user = { id: ME };
  session.rpc.mockReset();
  loadMemberDocument.mockReset().mockResolvedValue({
    ok: true,
    doc: { id: DOC, workspace_id: WS, title: "Roadmap", markdown: "# old", version: 3 },
  });
  workspaceTitles.mockReset().mockResolvedValue({ titles: ["Other"], error: null });
  consumeAiQuota.mockReset().mockResolvedValue({ ok: true, used: 1, limit: 30 });
  improveMarkdown.mockReset().mockResolvedValue("# new");
  generateAndStoreMindmap.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/regenerate and the edit lock (D-17)", () => {
  it("needs the editor's session, before anything is charged", async () => {
    for (const body of [{ id: DOC }, { id: DOC, session: "tab-1" }]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
    }
    expect(session.rpc).not.toHaveBeenCalled();
    expect(consumeAiQuota).not.toHaveBeenCalled();
  });

  it("refuses with 423, charging nothing, while someone else holds the lock", async () => {
    database({ take: lockRow({ mine: false, holder: ANA, holder_name: "ana" }) });
    const res = await POST(post({ id: DOC, session: TAB }));
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe("NOT_LOCK_HOLDER");
    expect(consumeAiQuota).not.toHaveBeenCalled();
    expect(improveMarkdown).not.toHaveBeenCalled();
  });

  it("refuses with 423 when the caller holds it from another tab", async () => {
    database({ take: lockRow({ mine: false, mine_elsewhere: true }) });
    const res = await POST(post({ id: DOC, session: TAB }));
    expect(res.status).toBe(423);
    expect((await res.json()).error).toMatch(/another tab/);
    expect(consumeAiQuota).not.toHaveBeenCalled();
  });

  it("maps a viewer's refusal from the lock and charges nothing", async () => {
    session.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "you can read this note but not edit it" },
    });
    const res = await POST(post({ id: DOC, session: TAB }));
    expect(res.status).toBe(403);
    expect(consumeAiQuota).not.toHaveBeenCalled();
  });

  it("renews the lock as the user before charging, then saves on the version it read", async () => {
    database();
    const res = await POST(post({ id: DOC, session: TAB }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ markdown: "# new", version: 4 });

    expect(session.rpc).toHaveBeenNthCalledWith(1, "take_doc_lock", {
      p_document_id: DOC,
      p_session: TAB,
      p_takeover: false,
    });
    expect(session.rpc).toHaveBeenNthCalledWith(2, "save_document", {
      p_document_id: DOC,
      p_markdown: "# new",
      p_base_version: 3,
      p_session: TAB,
    });
    // Renewed before the quota was charged and the model called.
    const renewedAt = session.rpc.mock.invocationCallOrder[0];
    expect(renewedAt).toBeLessThan(consumeAiQuota.mock.invocationCallOrder[0]);
    expect(renewedAt).toBeLessThan(improveMarkdown.mock.invocationCallOrder[0]);
  });

  it("answers 409 when the note was saved while the model ran", async () => {
    database({
      save: { data: null, error: { code: "DQVER", message: "saved elsewhere", details: "4" } },
    });
    const res = await POST(post({ id: DOC, session: TAB }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STALE_VERSION");
    expect(generateAndStoreMindmap).not.toHaveBeenCalled();
  });

  it("answers 423 when the lock was taken over while the model ran", async () => {
    database({
      save: { data: null, error: { code: "DQLCK", message: "you are not holding the edit lock on this note" } },
    });
    const res = await POST(post({ id: DOC, session: TAB }));
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe("NOT_LOCK_HOLDER");
    expect(generateAndStoreMindmap).not.toHaveBeenCalled();
  });
});
