import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where an upload goes is settled before anything is spent (WP-1.7, D-57):
 * a workspace the user may not add notes to is refused with 403 before the
 * AI quota is charged and before the pipeline archives the original.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const TEAM = "10000000-0000-4000-8000-000000000002";

const session = { user: { id: ME } as { id: string } | null };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.user } }) },
  }),
  createSupabaseAdminClient: () => ({}),
}));
vi.mock("@/lib/openai", () => ({ classifyUpload: () => "markdown" }));

const consumeAiQuota = vi.fn();
vi.mock("@/lib/ai-quota", () => ({
  consumeAiQuota: (...args: unknown[]) => consumeAiQuota(...args),
  quotaRefusal: () => Response.json({ error: "quota" }, { status: 429 }),
}));

const runIngest = vi.fn();
vi.mock("@/lib/ingest/pipeline", () => ({
  runIngest: (...args: unknown[]) => runIngest(...args),
  ingestStream: (run: (emit: () => void) => Promise<void>) => {
    void run(() => {});
    return new Response("stream", { status: 200 });
  },
}));

const workspaceForCreate = vi.fn();
vi.mock("@/lib/active-workspace", () => ({
  readActiveWorkspaceCookie: async () => null,
  workspaceForCreate: (...args: unknown[]) => workspaceForCreate(...args),
}));

const { POST } = await import("./route");

function upload(workspaceId?: string) {
  const form = new FormData();
  form.set("file", new File(["# Plan"], "plan.md", { type: "text/markdown" }));
  if (workspaceId) form.set("workspaceId", workspaceId);
  return POST(new Request("https://doqtri.test/api/ingest", { method: "POST", body: form }));
}

beforeEach(() => {
  session.user = { id: ME };
  consumeAiQuota.mockReset();
  consumeAiQuota.mockResolvedValue({ ok: true });
  runIngest.mockReset();
  runIngest.mockResolvedValue(undefined);
  workspaceForCreate.mockReset();
});

describe("POST /api/ingest", () => {
  it("refuses a workspace the user may not add to with 403, before charging or archiving anything", async () => {
    workspaceForCreate.mockResolvedValue({ ok: false, status: 403, error: "You're a viewer in Acme." });
    const res = await upload(TEAM);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "WORKSPACE_REFUSED" });
    expect(consumeAiQuota).not.toHaveBeenCalled();
    expect(runIngest).not.toHaveBeenCalled();
  });

  it("charges the quota and imports into the accepted workspace", async () => {
    workspaceForCreate.mockResolvedValue({ ok: true, workspaceId: TEAM });
    const res = await upload(TEAM);
    expect(res.status).toBe(200);
    expect(workspaceForCreate).toHaveBeenCalledWith(expect.anything(), ME, { requested: TEAM, cookie: null });
    expect(consumeAiQuota).toHaveBeenCalledWith(expect.anything(), ME, "ingest");
    expect(runIngest.mock.calls[0][0]).toMatchObject({ userId: ME, workspaceId: TEAM });
  });

  it("imports nothing when the quota is spent", async () => {
    workspaceForCreate.mockResolvedValue({ ok: true, workspaceId: TEAM });
    consumeAiQuota.mockResolvedValue({ ok: false });
    expect((await upload(TEAM)).status).toBe(429);
    expect(runIngest).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    session.user = null;
    expect((await upload()).status).toBe(401);
    expect(workspaceForCreate).not.toHaveBeenCalled();
  });
});
