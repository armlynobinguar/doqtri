import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may make the server spend its keys working a workspace's on-chain
 * queue (D-16, D-57): its members, and someone a pending job is about. The
 * route asks through the caller's own client (RLS), never the service role.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const TEAM = "10000000-0000-4000-8000-000000000002";

const state = vi.hoisted(() => ({
  user: { id: "00000000-0000-4000-8000-000000000003" } as { id: string } | null,
  /** Rows RLS shows the caller, per table. */
  visible: { workspaces: 0, workspace_chain_jobs: 0 } as Record<string, number>,
  editors: true,
  adminUsed: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => ({
      select: () => ({ eq: async () => ({ count: state.visible[table] ?? 0, error: null }) }),
    }),
  }),
  createSupabaseAdminClient: () => {
    state.adminUsed = true;
    return {};
  },
}));
vi.mock("@/lib/stellar/config", () => ({
  get REGISTRY_EDITORS() {
    return state.editors;
  },
}));

const runChainJobs = vi.fn();
vi.mock("@/lib/stellar/chain-jobs", () => ({
  runChainJobs: (...args: unknown[]) => runChainJobs(...args),
}));

const { POST } = await import("./route");

const sync = (id = TEAM) =>
  POST(new Request(`https://doqtri.test/api/workspaces/${id}/chain-sync`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  state.user = { id: ME };
  state.visible = { workspaces: 0, workspace_chain_jobs: 0 };
  state.editors = true;
  state.adminUsed = false;
  runChainJobs.mockReset();
  runChainJobs.mockResolvedValue({ done: 1, pending: 0, failed: 0, needsProductOwner: 0 });
});

describe("POST /api/workspaces/[id]/chain-sync", () => {
  it("refuses a signed-in non-member with no jobs as not found, and runs nothing", async () => {
    const res = await sync();
    expect(res.status).toBe(404);
    expect(runChainJobs).not.toHaveBeenCalled();
    expect(state.adminUsed).toBe(false);
  });

  it("lets a member run their workspace's queue, and only that workspace's", async () => {
    state.visible.workspaces = 1;
    const res = await sync();
    expect(res.status).toBe(200);
    expect(runChainJobs).toHaveBeenCalledWith(expect.anything(), { workspaceId: TEAM, limit: 10 });
  });

  it("lets a removed member whose own removal is pending run it (D-16)", async () => {
    state.visible.workspace_chain_jobs = 1;
    expect((await sync()).status).toBe(200);
    expect(runChainJobs).toHaveBeenCalledTimes(1);
  });

  it("asks for a session, and refuses an id that is not a workspace", async () => {
    state.user = null;
    state.visible.workspaces = 1;
    expect((await sync()).status).toBe(401);
    state.user = { id: ME };
    expect((await sync("not-a-workspace")).status).toBe(404);
    expect(runChainJobs).not.toHaveBeenCalled();
  });

  it("sends nothing with REGISTRY_EDITORS off", async () => {
    state.editors = false;
    state.visible.workspaces = 1;
    const res = await sync();
    expect(await res.json()).toMatchObject({ skipped: true });
    expect(runChainJobs).not.toHaveBeenCalled();
  });
});
