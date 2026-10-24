import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hash, Keypair, StrKey } from "@stellar/stellar-sdk";
import { registryAccess } from "@/lib/stellar/registry-access";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";

/**
 * registryAccess against a stubbed Supabase client: every query is recorded
 * (table, columns, filters) and answered from rows the test keys by table, so
 * these tests pin the tables and columns the relay's lookups read.
 */
type Query = { table: string; columns: string; filters: Record<string, unknown> };
type Rows = Record<string, Record<string, unknown>[]>;

function stubClient(rows: Rows, queries: Query[], failing?: string): SupabaseClient {
  return {
    from(table: string) {
      const query: Query = { table, columns: "", filters: {} };
      queries.push(query);
      const builder = {
        select(columns: string) {
          query.columns = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          query.filters[column] = value;
          return builder;
        },
        async maybeSingle() {
          if (table === failing) return { data: null, error: { message: "boom" } };
          const match = (rows[table] ?? []).filter((row) =>
            Object.entries(query.filters).every(([column, value]) => row[column] === value),
          );
          return { data: match[0] ?? null, error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const docId = "3f1c2a9e-0000-4000-8000-0000000000d1";
const team = "7a000000-0000-4000-8000-0000000000d1";
const passkey = StrKey.encodeContract(hash(Buffer.from("passkey-wallet")));
const freighter = Keypair.random().publicKey();
const otherNetwork = NETWORK === "testnet" ? "mainnet" : "testnet";

const rows: Rows = {
  documents: [{ id: docId, user_id: "u-author", workspace_id: team, workspaces: { is_personal: false } }],
  workspace_members: [
    { workspace_id: team, user_id: "u-passkey", role: "editor" },
    { workspace_id: team, user_id: "u-freighter", role: "admin" },
    { workspace_id: team, user_id: "u-elsewhere", role: "owner" },
  ],
  smart_wallets: [
    { user_id: "u-passkey", network: NETWORK, address: passkey },
    // The same address on the other network belongs to nobody here.
    { user_id: "u-elsewhere", network: otherNetwork, address: StrKey.encodeContract(hash(Buffer.from("elsewhere"))) },
  ],
  wallet_accounts: [{ user_id: "u-freighter", address: freighter }],
};

describe("registryAccess", () => {
  it("reads a note's workspace, whether it is personal, and its author", async () => {
    const queries: Query[] = [];
    const access = registryAccess(stubClient(rows, queries));
    await expect(access.documentWorkspace(docId)).resolves.toEqual({
      workspaceId: team,
      personal: false,
      creatorId: "u-author",
    });
    expect(queries).toEqual([
      { table: "documents", columns: "user_id, workspace_id, workspaces(is_personal)", filters: { id: docId } },
    ]);
  });

  it("reads a personal note, and one whose author's account is gone", async () => {
    const personal: Rows = {
      documents: [{ id: docId, user_id: null, workspace_id: team, workspaces: [{ is_personal: true }] }],
    };
    await expect(registryAccess(stubClient(personal, [])).documentWorkspace(docId)).resolves.toEqual({
      workspaceId: team,
      personal: true,
      creatorId: null,
    });
  });

  it("does not query for a doc id that is not a UUID", async () => {
    const queries: Query[] = [];
    await expect(registryAccess(stubClient(rows, queries)).documentWorkspace("not-a-uuid")).resolves.toBeNull();
    expect(queries).toEqual([]);
  });

  it("answers null for a note that is not there", async () => {
    const missing = "3f1c2a9e-0000-4000-8000-0000000000ff";
    await expect(registryAccess(stubClient(rows, [])).documentWorkspace(missing)).resolves.toBeNull();
  });

  it("reads the caller's current role from workspace_members", async () => {
    const queries: Query[] = [];
    const access = registryAccess(stubClient(rows, queries));
    await expect(access.memberRole(team, "u-passkey")).resolves.toBe("editor");
    await expect(access.memberRole(team, "u-removed")).resolves.toBeNull();
    expect(queries[0]).toEqual({
      table: "workspace_members",
      columns: "role",
      filters: { workspace_id: team, user_id: "u-passkey" },
    });
  });

  it("resolves a passkey wallet through smart_wallets on this network", async () => {
    const queries: Query[] = [];
    await expect(registryAccess(stubClient(rows, queries)).addressRole(team, passkey)).resolves.toBe("editor");
    expect(queries[0]).toEqual({
      table: "smart_wallets",
      columns: "user_id",
      filters: { network: NETWORK, address: passkey },
    });
  });

  it("does not resolve a passkey wallet registered on the other network", async () => {
    const elsewhere = rows.smart_wallets[1].address as string;
    await expect(registryAccess(stubClient(rows, [])).addressRole(team, elsewhere)).resolves.toBeNull();
  });

  it("resolves a Freighter account through wallet_accounts", async () => {
    const queries: Query[] = [];
    await expect(registryAccess(stubClient(rows, queries)).addressRole(team, freighter)).resolves.toBe("admin");
    expect(queries[0]).toEqual({ table: "wallet_accounts", columns: "user_id", filters: { address: freighter } });
  });

  it("answers null for an address nobody holds, and queries nothing for one that is not an address", async () => {
    const queries: Query[] = [];
    const access = registryAccess(stubClient(rows, queries));
    await expect(access.addressRole(team, Keypair.random().publicKey())).resolves.toBeNull();
    await expect(access.addressRole(team, "not-an-address")).resolves.toBeNull();
    expect(queries.map((q) => q.table)).toEqual(["wallet_accounts"]);
  });

  it("throws, rather than refusing quietly, when a lookup fails", async () => {
    await expect(registryAccess(stubClient(rows, [], "documents")).documentWorkspace(docId)).rejects.toThrow(
      /documents lookup failed/,
    );
    await expect(registryAccess(stubClient(rows, [], "smart_wallets")).addressRole(team, passkey)).rejects.toThrow(
      /wallet lookup failed/,
    );
  });
});
