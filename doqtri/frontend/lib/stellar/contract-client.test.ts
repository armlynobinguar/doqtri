import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash, StrKey } from "@stellar/stellar-sdk";

/**
 * Which registry calls a write uses (WP-1.4). The generated client is
 * replaced by a recorder: every method call is logged with its arguments and
 * answers from a per-method queue, so these tests see exactly which contract
 * functions a write would invoke, with what, in what order.
 */
const state = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  results: {} as Record<string, unknown[]>,
  relayed: 0,
}));

const METHODS = [
  "anchor",
  "anchor_as",
  "register_document",
  "update_document",
  "update_document_as",
  "set_node_status",
  "set_node_status_as",
  "assign_document",
  "get_document",
  "get_doc_workspace",
  "get_workspace",
  "get_node",
  "add_admin",
];

vi.mock("@/lib/bindings/doqtri-registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/bindings/doqtri-registry")>();
  class Client {
    constructor(readonly options: unknown) {}
  }
  for (const fn of METHODS) {
    Object.defineProperty(Client.prototype, fn, {
      value: async (args: Record<string, unknown> = {}) => {
        state.calls.push({ fn, args });
        const queue = state.results[fn] ?? [];
        return { result: queue.length > 1 ? queue.shift() : queue[0], simulation: {}, built: { fee: "100" } };
      },
    });
  }
  return { ...real, Client };
});

vi.mock("@/lib/passkey-wallet", () => ({
  passkeyWalletFor: (address: string) => ({ address, createdTx: "", passkeys: [] }),
  signAndRelay: async () => `tx-${++state.relayed}`,
  payAndRelay: async () => ({ hash: `tx-${++state.relayed}`, feeStroops: BigInt(0) }),
}));

vi.mock("@/lib/wallet", () => ({ signSorobanTx: async () => "" }));

// The relay already waited for the ledger; the version label is best effort.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class Server {
    async getTransaction(): Promise<never> {
      throw new Error("offline");
    }
  }
  return { ...real, rpc: { ...real.rpc, Server } };
});

const wallet = StrKey.encodeContract(hash(Buffer.from("member-wallet")));
const someoneElse = StrKey.encodeContract(hash(Buffer.from("other-wallet")));
const docId = "3f1c2a9e-0000-4000-8000-0000000000c1";
const contentHash = "ab".repeat(32);
const team = { workspaceId: "7a000000-0000-4000-8000-0000000000c1", personal: false };
const personal = { workspaceId: "7a000000-0000-4000-8000-0000000000c2", personal: true };
const done = [{ nodeId: "root", status: "Verified" as const, tool: "doqtri-done", artifactRef: "v1" }];

const chainDoc = (owner: string) => ({
  owner,
  version: 1,
  node_count: 0,
  content_hash: Buffer.alloc(32, 0xab),
  updated_at: BigInt(1),
});
const contractError = (message: string) => ({
  isErr: () => true,
  unwrap: () => undefined,
  unwrapErr: () => ({ message }),
});

async function load(editors: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REGISTRY_EDITORS", editors ? "1" : "");
  return import("./contract-client");
}

const called = () => state.calls.map((c) => c.fn);

beforeEach(() => {
  state.calls = [];
  state.results = {};
  state.relayed = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("writeMode", () => {
  it("uses the *_as calls only for a team workspace's note, and only when enabled", async () => {
    const { writeMode } = await load(false);
    expect(writeMode(team, true)).toBe("editor");
    expect(writeMode(personal, true)).toBe("owner");
    expect(writeMode(null, true)).toBe("owner");
    expect(writeMode(undefined, true)).toBe("owner");
    expect(writeMode(team, false)).toBe("owner");
  });

  it("follows NEXT_PUBLIC_REGISTRY_EDITORS, off by default", async () => {
    expect((await load(false)).writeMode(team)).toBe("owner");
    expect((await load(true)).writeMode(team)).toBe("editor");
  });
});

describe("with NEXT_PUBLIC_REGISTRY_EDITORS off (the live registry)", () => {
  it("keeps every write on the owner-only calls, team note or not", async () => {
    const { DoqtriRegistry } = await load(false);
    state.results.anchor = [1];
    const receipt = await DoqtriRegistry.anchor(wallet, docId, contentHash, done, team);
    await DoqtriRegistry.updateDocument(wallet, docId, contentHash, team);
    await DoqtriRegistry.setNodeStatus(wallet, docId, "h1", "Built", "github", "pr#1", team);
    expect(called()).toEqual(["anchor", "update_document", "set_node_status"]);
    expect(state.calls[0].args.owner).toBe(wallet);
    expect(receipt.workspace).toBeUndefined();
  });

  it("refuses to assign a note", async () => {
    const { DoqtriRegistry } = await load(false);
    await expect(DoqtriRegistry.assignDocument(wallet, docId, team.workspaceId)).rejects.toThrow(/aren't enabled/);
    expect(called()).toEqual([]);
  });
});

describe("with NEXT_PUBLIC_REGISTRY_EDITORS on", () => {
  it("keeps a personal note on the owner-only calls and never assigns it", async () => {
    const { DoqtriRegistry } = await load(true);
    state.results.anchor = [1];
    const receipt = await DoqtriRegistry.anchor(wallet, docId, contentHash, done, personal);
    expect(called()).toEqual(["anchor"]);
    expect(receipt.workspace).toBeUndefined();
  });

  it("anchors a new team note with anchor_as, then assigns it and reads the assignment back", async () => {
    const { DoqtriRegistry } = await load(true);
    state.results.anchor_as = [1];
    // Not in a workspace until assign_document lands, then in the team's.
    state.results.get_doc_workspace = [undefined, team.workspaceId];
    state.results.get_document = [chainDoc(wallet)];
    const receipt = await DoqtriRegistry.anchor(wallet, docId, contentHash, done, team);

    expect(called()).toEqual(["anchor_as", "get_doc_workspace", "get_document", "assign_document", "get_doc_workspace"]);
    expect(state.calls[0].args).toMatchObject({ signer: wallet, doc_id: docId });
    expect(state.calls[0].args).not.toHaveProperty("owner");
    expect(state.calls[3].args).toEqual({ doc_id: docId, workspace_id: team.workspaceId });
    expect(receipt).toMatchObject({ txHash: "tx-1", workspace: { status: "assigned", txHash: "tx-2" } });
  });

  it("registers a new team note through anchor_as with no nodes (there is no register_document_as)", async () => {
    const { DoqtriRegistry } = await load(true);
    state.results.anchor_as = [1];
    state.results.get_doc_workspace = [undefined, team.workspaceId];
    state.results.get_document = [chainDoc(wallet)];
    await DoqtriRegistry.registerDocument(wallet, docId, contentHash, team);
    expect(called()[0]).toBe("anchor_as");
    expect(state.calls[0].args.nodes).toEqual([]);
    expect(called()).not.toContain("register_document");
    expect(called()).toContain("assign_document");
  });

  it("writes an assigned team note with the *_as calls and no second signature", async () => {
    const { DoqtriRegistry } = await load(true);
    state.results.update_document_as = [2];
    state.results.get_doc_workspace = [team.workspaceId];
    const update = await DoqtriRegistry.updateDocument(wallet, docId, contentHash, team);
    const node = await DoqtriRegistry.setNodeStatus(wallet, docId, "h1", "Built", "github", "pr#1", team);

    expect(called()).toEqual(["update_document_as", "get_doc_workspace", "set_node_status_as", "get_doc_workspace"]);
    expect(state.calls[0].args).toMatchObject({ signer: wallet, doc_id: docId });
    expect(state.calls[2].args).toMatchObject({ signer: wallet, doc_id: docId, node_id: "h1", tool: "github" });
    expect(update.workspace).toEqual({ status: "assigned" });
    expect(node.workspace).toEqual({ status: "assigned" });
    expect(state.relayed).toBe(2);
  });

  it("does not try to assign a note another wallet owns on-chain", async () => {
    const { DoqtriRegistry } = await load(true);
    state.results.update_document_as = [2];
    state.results.get_doc_workspace = [undefined];
    state.results.get_document = [chainDoc(someoneElse)];
    const receipt = await DoqtriRegistry.updateDocument(wallet, docId, contentHash, team);
    expect(called()).not.toContain("assign_document");
    expect(receipt.workspace).toMatchObject({ status: "unassigned", reason: expect.stringMatching(/owns this note/) });
  });

  it("moves a note still in its old workspace on-chain when the signer owns that workspace now", async () => {
    const { DoqtriRegistry } = await load(true);
    const old = "7a000000-0000-4000-8000-0000000000c3";
    state.results.update_document_as = [2];
    state.results.get_doc_workspace = [old, team.workspaceId];
    // The stored owner lags behind a transfer_workspace; the workspace's owner is what counts.
    state.results.get_document = [chainDoc(someoneElse)];
    state.results.get_workspace = [{ owner: wallet, created_at: BigInt(1), members: new Map() }];
    const receipt = await DoqtriRegistry.updateDocument(wallet, docId, contentHash, team);

    expect(called()).toEqual(["update_document_as", "get_doc_workspace", "get_workspace", "assign_document", "get_doc_workspace"]);
    expect(state.calls[2].args).toEqual({ workspace_id: old });
    expect(receipt.workspace).toEqual({ status: "assigned", txHash: "tx-2" });
  });

  it("leaves a moved note alone when its old workspace has another owner, whatever its stored owner says", async () => {
    const { DoqtriRegistry } = await load(true);
    const old = "7a000000-0000-4000-8000-0000000000c3";
    state.results.update_document_as = [2];
    state.results.get_doc_workspace = [old];
    // Stored as the signer's, but the old workspace was transferred away from them.
    state.results.get_document = [chainDoc(wallet)];
    state.results.get_workspace = [{ owner: someoneElse, created_at: BigInt(1), members: new Map() }];
    const receipt = await DoqtriRegistry.updateDocument(wallet, docId, contentHash, team);

    expect(called()).not.toContain("assign_document");
    expect(called()).not.toContain("get_document");
    expect(receipt.workspace).toMatchObject({
      status: "unassigned",
      reason: expect.stringMatching(/only that workspace's owner can move it/),
    });
  });

  it("reports, without throwing, an assignment the contract refuses", async () => {
    const { DoqtriRegistry } = await load(true);
    state.results.anchor_as = [1];
    state.results.get_doc_workspace = [undefined];
    state.results.get_document = [chainDoc(wallet)];
    state.results.assign_document = [contractError("WorkspaceNotFound")];
    const receipt = await DoqtriRegistry.anchor(wallet, docId, contentHash, done, team);
    expect(receipt.txHash).toBe("tx-1");
    expect(receipt.workspace).toEqual({ status: "unassigned", reason: "This workspace isn't on-chain yet." });
    // Refused in simulation: nothing was signed or relayed for it.
    expect(state.relayed).toBe(1);
  });

  it("names the error when the chain doesn't list the signer as an editor", async () => {
    const { DoqtriRegistry } = await load(true);
    state.results.anchor_as = [contractError("NotEditor")];
    await expect(DoqtriRegistry.anchor(wallet, docId, contentHash, done, team)).rejects.toMatchObject({
      code: "NOT_EDITOR",
    });
    expect(state.relayed).toBe(0);
  });
});

describe("addAdmin (the follow-up to a transfer, D-35)", () => {
  const formerOwner = StrKey.encodeContract(hash(Buffer.from("former-owner")));

  it("has the new owner sign add_admin for the former owner, through the relay", async () => {
    const { DoqtriRegistry } = await load(true);
    const receipt = await DoqtriRegistry.addAdmin(wallet, team.workspaceId, formerOwner);
    expect(state.calls).toEqual([
      { fn: "add_admin", args: { workspace_id: team.workspaceId, owner: wallet, admin: formerOwner } },
    ]);
    expect(receipt).toEqual({ txHash: "tx-1" });
  });

  it("names the contract's refusal before anything is signed", async () => {
    const { DoqtriRegistry } = await load(true);
    state.results.add_admin = [contractError("NotWorkspaceOwner")];
    await expect(DoqtriRegistry.addAdmin(someoneElse, team.workspaceId, formerOwner)).rejects.toMatchObject({
      code: "NOT_WORKSPACE_OWNER",
    });
    expect(state.relayed).toBe(0);
  });

  it("refuses while the registry has no workspace calls", async () => {
    const { DoqtriRegistry } = await load(false);
    await expect(DoqtriRegistry.addAdmin(wallet, team.workspaceId, formerOwner)).rejects.toThrow(/aren't enabled/);
    expect(called()).toEqual([]);
  });
});
