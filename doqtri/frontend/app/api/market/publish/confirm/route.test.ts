import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Step 2 of publishing checks the author again (D-41, D-57): an author
 * removed from the note's workspace, or demoted to viewer, between signing
 * `list_template` and confirming it is not shown in the gallery.
 */

const ME = "00000000-0000-4000-8000-000000000003";
const NOTE = "30000000-0000-4000-8000-000000000001";
const TEMPLATE = "abcdefghijklmnop";
const WALLET = "C" + "W".repeat(55);

const state = vi.hoisted(() => ({
  user: { id: "00000000-0000-4000-8000-000000000003" } as { id: string } | null,
  row: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
  createSupabaseAdminClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: state.row }),
        update: (values: Record<string, unknown>) => {
          state.updates.push(values);
          return { eq: async () => ({ error: null }) };
        },
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/stellar/config", () => ({ MARKET_CONTRACT_ID: "C" + "M".repeat(55) }));
vi.mock("@/lib/stellar/smart-wallet-config", () => ({ NETWORK: "testnet" }));

const readChainTemplate = vi.fn();
vi.mock("@/lib/stellar/market-reads", () => ({
  readChainTemplate: (...args: unknown[]) => readChainTemplate(...args),
}));

const loadAuthoredDocument = vi.fn();
vi.mock("@/lib/workspace-docs", () => ({
  loadAuthoredDocument: (...args: unknown[]) => loadAuthoredDocument(...args),
}));

const { POST } = await import("./route");

const confirm = () =>
  POST(
    new Request("https://doqtri.test/api/market/publish/confirm", {
      method: "POST",
      body: JSON.stringify({ templateId: TEMPLATE }),
    }),
  );

beforeEach(() => {
  state.user = { id: ME };
  state.updates = [];
  state.row = {
    id: TEMPLATE,
    status: "pending",
    creator_wallet: WALLET,
    content_hash: "ab".repeat(32),
    token: "C" + "T".repeat(55),
    price: "0",
    parent_id: null,
    note_id: NOTE,
  };
  readChainTemplate.mockReset();
  readChainTemplate.mockResolvedValue({
    creator: WALLET,
    contentHash: "ab".repeat(32),
    token: "C" + "T".repeat(55),
    price: BigInt(0),
    parent: null,
    listed: true,
    createdAt: 1_760_000_000,
    sales: 0,
    earned: BigInt(0),
  });
  loadAuthoredDocument.mockReset();
  loadAuthoredDocument.mockResolvedValue({ ok: true, doc: { id: NOTE, workspace_id: "w", user_id: ME }, role: "editor" });
});

describe("POST /api/market/publish/confirm", () => {
  it("lists the template once the ledger agrees and the author is still an editor", async () => {
    const res = await confirm();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ templateId: TEMPLATE, status: "listed" });
    expect(loadAuthoredDocument).toHaveBeenCalledWith(expect.anything(), { userId: ME, docId: NOTE });
    expect(state.updates).toHaveLength(1);
  });

  it("refuses an author removed from the workspace since step 1, before reading the ledger (D-41)", async () => {
    loadAuthoredDocument.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await confirm();
    expect(res.status).toBe(403);
    expect(readChainTemplate).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it("refuses an author demoted to viewer", async () => {
    loadAuthoredDocument.mockResolvedValue({ ok: false, reason: "forbidden", role: "viewer" });
    expect((await confirm()).status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });

  it("refuses when the note was deleted since step 1, as it can no longer be checked", async () => {
    state.row = { ...state.row, note_id: null };
    expect((await confirm()).status).toBe(403);
    expect(loadAuthoredDocument).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it("answers 500, listing nothing, when the check itself fails", async () => {
    loadAuthoredDocument.mockResolvedValue({ ok: false, reason: "error", message: "boom" });
    expect((await confirm()).status).toBe(500);
    expect(state.updates).toHaveLength(0);
  });

  it("stays idempotent for a template already confirmed", async () => {
    state.row = { ...state.row, status: "listed" };
    const res = await confirm();
    expect(await res.json()).toEqual({ templateId: TEMPLATE, status: "listed" });
    expect(loadAuthoredDocument).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    state.user = null;
    expect((await confirm()).status).toBe(401);
  });
});
