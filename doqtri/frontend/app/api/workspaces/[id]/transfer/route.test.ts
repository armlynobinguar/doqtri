import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Only the new owner a transfer names can accept it (D-29, D-57), and the
 * database step is given the id from the verified session, never one from
 * the request.
 */

const OWNER = "00000000-0000-4000-8000-000000000001";
const HEIR = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const TEAM = "10000000-0000-4000-8000-000000000002";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  transfer: null as Record<string, unknown> | null,
  rpcs: [] as [string, Record<string, unknown>][],
  editors: false,
}));

vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
  createSupabaseAdminClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: state.transfer, error: null }),
      };
      return query;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push([fn, args]);
      return { data: fn === "accept_workspace_transfer" ? OWNER : null, error: null };
    },
  }),
}));
vi.mock("@/lib/stellar/config", () => ({
  CONTRACT_ID: "C" + "R".repeat(55),
  get REGISTRY_EDITORS() {
    return state.editors;
  },
}));
vi.mock("@/lib/stellar/smart-wallet-config", () => ({ NETWORK: "testnet" }));
vi.mock("@/lib/stellar/registry-access", () => ({ registryAccess: () => ({}) }));
const readChainWorkspace = vi.fn();
vi.mock("@/lib/stellar/server-signer", () => ({
  readChainWorkspace: (...args: unknown[]) => readChainWorkspace(...args),
}));
const submitAndConfirm = vi.fn();
vi.mock("@/lib/stellar/channels", () => ({
  simulateWithinCap: async () => {},
  submitAndConfirm: (...args: unknown[]) => submitAndConfirm(...args),
}));
vi.mock("@/lib/stellar/chain-jobs", () => ({ runChainJobs: async () => ({}) }));

const { POST } = await import("./route");

const accept = (id = TEAM, body: unknown = {}) =>
  POST(new Request(`https://doqtri.test/api/workspaces/${id}/transfer`, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  state.user = { id: HEIR };
  state.transfer = {
    workspace_id: TEAM,
    from_user: OWNER,
    to_user: HEIR,
    owner_address: null,
    new_owner_address: null,
    owner_approval: null,
  };
  state.rpcs = [];
  state.editors = false;
  readChainWorkspace.mockReset();
  submitAndConfirm.mockReset();
});

describe("POST /api/workspaces/[id]/transfer", () => {
  it("refuses anyone but the new owner as not found, and changes nothing", async () => {
    for (const id of [OWNER, OTHER]) {
      state.user = { id };
      const res = await accept();
      expect(res.status).toBe(404);
    }
    expect(state.rpcs).toEqual([]);
    expect(submitAndConfirm).not.toHaveBeenCalled();
  });

  it("refuses when there is no open transfer", async () => {
    state.transfer = null;
    expect((await accept()).status).toBe(404);
    expect(state.rpcs).toEqual([]);
  });

  it("accepts for the new owner, naming them from the session", async () => {
    const res = await accept(TEAM, { userId: OTHER });
    expect(res.status).toBe(200);
    expect(state.rpcs).toEqual([["accept_workspace_transfer", { p_workspace_id: TEAM, p_user_id: HEIR }]]);
  });

  it("with the workspace on-chain, refuses a transfer the owner's wallet never signed", async () => {
    state.editors = true;
    readChainWorkspace.mockResolvedValue({ owner: "C" + "O".repeat(55) });
    const res = await accept();
    expect(res.status).toBe(409);
    expect(submitAndConfirm).not.toHaveBeenCalled();
    expect(state.rpcs.map(([fn]) => fn)).not.toContain("accept_workspace_transfer");
  });

  it("asks for a session, and refuses an id that is not a workspace", async () => {
    expect((await accept("nope")).status).toBe(404);
    state.user = null;
    expect((await accept()).status).toBe(401);
    expect(state.rpcs).toEqual([]);
  });
});
