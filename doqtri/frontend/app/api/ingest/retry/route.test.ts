import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A retry lands in the workspace the vault is showing (D-56), so it is
 * checked like a fresh upload (WP-1.7, D-57): a refused workspace answers
 * 403 before the quota is charged and before the archived original is read.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const TEAM = "10000000-0000-4000-8000-000000000002";
const INGEST = "40000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({
  user: { id: "00000000-0000-4000-8000-000000000003" } as { id: string } | null,
  attempt: null as Record<string, unknown> | null,
  ingestFilters: [] as [string, unknown][],
}));
const download = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
  createSupabaseAdminClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          state.ingestFilters.push([column, value]);
          return query;
        },
        maybeSingle: async () => ({ data: state.attempt }),
      };
      return query;
    },
    storage: { from: () => ({ download: (...args: unknown[]) => download(...args) }) },
  }),
}));

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

const retry = (body: Record<string, unknown> = { ingestId: INGEST, workspaceId: TEAM }) =>
  POST(new Request("https://doqtri.test/api/ingest/retry", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  state.user = { id: ME };
  state.attempt = { id: INGEST, object_path: `${ME}/plan.md`, filename: "plan.md", kind: "markdown", status: "failed" };
  state.ingestFilters = [];
  consumeAiQuota.mockReset();
  consumeAiQuota.mockResolvedValue({ ok: true });
  runIngest.mockReset();
  runIngest.mockResolvedValue(undefined);
  download.mockReset();
  download.mockResolvedValue({ data: new Blob(["# Plan"], { type: "text/markdown" }), error: null });
  workspaceForCreate.mockReset();
});

describe("POST /api/ingest/retry", () => {
  it("refuses a workspace the user may not add to with 403, before charging or reading the original", async () => {
    workspaceForCreate.mockResolvedValue({ ok: false, status: 403, error: "You're a viewer in Acme." });
    const res = await retry();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "WORKSPACE_REFUSED" });
    expect(consumeAiQuota).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(runIngest).not.toHaveBeenCalled();
  });

  it("only ever reads the caller's own import", async () => {
    workspaceForCreate.mockResolvedValue({ ok: true, workspaceId: TEAM });
    await retry();
    expect(state.ingestFilters).toContainEqual(["user_id", ME]);
  });

  it("re-imports into the accepted workspace once charged", async () => {
    workspaceForCreate.mockResolvedValue({ ok: true, workspaceId: TEAM });
    const res = await retry({ ingestId: INGEST, workspaceId: TEAM, raw: true });
    expect(res.status).toBe(200);
    expect(workspaceForCreate).toHaveBeenCalledWith(expect.anything(), ME, { requested: TEAM, cookie: null });
    expect(consumeAiQuota).toHaveBeenCalledWith(expect.anything(), ME, "ingest-retry");
    expect(runIngest.mock.calls[0][0]).toMatchObject({ userId: ME, workspaceId: TEAM, raw: true });
  });

  it("answers 404 for an import that is not the caller's, or already succeeded, before checking the workspace", async () => {
    state.attempt = null;
    expect((await retry()).status).toBe(404);
    state.attempt = { id: INGEST, object_path: "x", filename: "plan.md", kind: "markdown", status: "succeeded" };
    expect((await retry()).status).toBe(404);
    expect(workspaceForCreate).not.toHaveBeenCalled();
    expect(consumeAiQuota).not.toHaveBeenCalled();
  });
});
