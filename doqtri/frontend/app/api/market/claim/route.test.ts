import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Use template" copies into the workspace on screen, editors and above only
 * (WP-1.7, D-14, D-57): a refused workspace answers 403 before the template,
 * the ledger or the purchase record is looked at, and nothing is copied.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const TEAM = "10000000-0000-4000-8000-000000000002";
const TEMPLATE = "abcdefghijklmnop";
const WALLET = "C" + "W".repeat(55);

const state = vi.hoisted(() => ({
  user: { id: "00000000-0000-4000-8000-000000000003" } as { id: string } | null,
  tables: [] as string[],
  inserts: [] as [string, unknown][],
  template: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      state.tables.push(table);
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: table === "market_templates" ? state.template : null }),
        insert: async (row: unknown) => {
          state.inserts.push([table, row]);
          return { error: null };
        },
      };
      return query;
    },
    rpc: async () => ({ error: null }),
  }),
}));
vi.mock("@/lib/stellar/config", () => ({ MARKET_CONTRACT_ID: "C" + "M".repeat(55) }));
vi.mock("@/lib/stellar/smart-wallet-config", () => ({ NETWORK: "testnet" }));

const readChainTemplate = vi.fn();
const readHasPurchased = vi.fn();
vi.mock("@/lib/stellar/market-reads", () => ({
  readChainTemplate: (...args: unknown[]) => readChainTemplate(...args),
  readHasPurchased: (...args: unknown[]) => readHasPurchased(...args),
}));
vi.mock("@/lib/market-server", () => ({
  purchaseColumns: () => ({}),
  saleFor: async () => ({ record: {} }),
  userWallet: async () => WALLET,
}));

const insertWorkspaceDocument = vi.fn();
vi.mock("@/lib/workspace-docs", () => ({
  insertWorkspaceDocument: (...args: unknown[]) => insertWorkspaceDocument(...args),
}));

const workspaceForCreate = vi.fn();
vi.mock("@/lib/active-workspace", () => ({
  readActiveWorkspaceCookie: async () => null,
  workspaceForCreate: (...args: unknown[]) => workspaceForCreate(...args),
}));

const { POST } = await import("./route");

const claim = () =>
  POST(
    new Request("https://doqtri.test/api/market/claim", {
      method: "POST",
      body: JSON.stringify({ templateId: TEMPLATE, workspaceId: TEAM, txHash: "ab".repeat(32) }),
    }),
  );

beforeEach(() => {
  state.user = { id: ME };
  state.tables = [];
  state.inserts = [];
  state.template = { id: TEMPLATE, title: "Roadmap", body: "## Goals", status: "listed", hidden: false, creator_id: "someone" };
  readChainTemplate.mockReset();
  readChainTemplate.mockResolvedValue({ listed: true, price: BigInt(5) });
  readHasPurchased.mockReset();
  readHasPurchased.mockResolvedValue(true);
  insertWorkspaceDocument.mockReset();
  insertWorkspaceDocument.mockResolvedValue({ id: "doc-1", title: "Roadmap" });
  workspaceForCreate.mockReset();
});

describe("POST /api/market/claim", () => {
  it("refuses a workspace the user may not add to with 403, before any lookup or record", async () => {
    workspaceForCreate.mockResolvedValue({ ok: false, status: 403, error: "You're a viewer in Acme." });
    const res = await claim();
    expect(res.status).toBe(403);
    expect(state.tables).toEqual([]);
    expect(readChainTemplate).not.toHaveBeenCalled();
    expect(readHasPurchased).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]);
    expect(insertWorkspaceDocument).not.toHaveBeenCalled();
  });

  it("copies a bought template into the accepted workspace, recording the purchase", async () => {
    workspaceForCreate.mockResolvedValue({ ok: true, workspaceId: TEAM });
    const res = await claim();
    expect(res.status).toBe(200);
    expect(workspaceForCreate).toHaveBeenCalledWith(expect.anything(), ME, { requested: TEAM, cookie: null });
    expect(state.inserts.map(([table]) => table)).toEqual(["market_purchases"]);
    expect(insertWorkspaceDocument.mock.calls[0][1]).toMatchObject({
      userId: ME,
      workspaceId: TEAM,
      extra: { source_template_id: TEMPLATE },
    });
  });

  it("copies nothing for a paid template the user has not bought", async () => {
    workspaceForCreate.mockResolvedValue({ ok: true, workspaceId: TEAM });
    readHasPurchased.mockResolvedValue(false);
    expect((await claim()).status).toBe(402);
    expect(insertWorkspaceDocument).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    state.user = null;
    expect((await claim()).status).toBe(401);
    expect(workspaceForCreate).not.toHaveBeenCalled();
  });
});
