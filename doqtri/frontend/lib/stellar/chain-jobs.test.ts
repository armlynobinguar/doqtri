import { describe, expect, it, vi } from "vitest";
import { hash, Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  processChainJobs,
  retryDelayMs,
  type ChainJob,
  type ChainJobStore,
  type JobUpdate,
  type OwnerReassigner,
} from "@/lib/stellar/chain-jobs";
import type { RevokerChain } from "@/lib/stellar/revoke-editor";
import type { ChainRole } from "@/lib/stellar/workspace-chain";
import type { WorkspaceRole } from "@/lib/workspace-roles";

const ws = "7a000000-0000-4000-8000-0000000000b1";
const editorWallet = StrKey.encodeContract(hash(Buffer.from("editor")));
const adminWallet = Keypair.random().publicKey();
const heirWallet = StrKey.encodeContract(hash(Buffer.from("heir")));
const now = new Date("2026-10-24T12:00:00Z");
const noSleep = async () => {};

function job(over: Partial<ChainJob>): ChainJob {
  return { id: "j1", workspace_id: ws, kind: "revoke", user_id: "u", address: editorWallet, network: "testnet", attempts: 1, ...over };
}

function memoryStore(jobs: ChainJob[], roles: Record<string, WorkspaceRole> = {}, wallets: Record<string, string> = {}) {
  const finished: Record<string, JobUpdate> = {};
  const store: ChainJobStore & { finished: typeof finished; claims: number; reopened: number } = {
    finished,
    claims: 0,
    reopened: 0,
    async claim() {
      store.claims++;
      return jobs.splice(0);
    },
    async finish(id, update) {
      finished[id] = update;
    },
    async reopenProductOwnerJobs() {
      store.reopened++;
    },
    roleOfAddress: async (_ws, address) => roles[address] ?? null,
    addressOf: async (userId) => wallets[userId] ?? null,
  };
  return store;
}

function chainWith(roles: Record<string, ChainRole>): RevokerChain & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    readRole: async (_ws, address) => roles[address] ?? null,
    async submit(fn, _ws, address) {
      sent.push(`${fn}:${address}`);
      roles[address] = null;
      return "ab".repeat(32);
    },
  };
}

const base = { network: "testnet", now: () => now, revokeOptions: { sleep: noSleep } };

describe("processChainJobs", () => {
  it("makes no chain calls and claims nothing while REGISTRY_EDITORS is off", async () => {
    const store = memoryStore([job({})]);
    const revoker = chainWith({ [editorWallet]: "editor" });
    const summary = await processChainJobs(store, { ...base, editors: false, revoker, reassigner: null });
    expect(summary.skipped).toBe(true);
    expect(store.claims).toBe(0);
    expect(revoker.sent).toEqual([]);
  });

  it("revokes a removed editor and records the job as done with its hash", async () => {
    const store = memoryStore([job({})]);
    const revoker = chainWith({ [editorWallet]: "editor" });
    const summary = await processChainJobs(store, { ...base, editors: true, revoker, reassigner: null });
    expect(revoker.sent).toEqual([`remove_editor:${editorWallet}`]);
    expect(store.finished.j1).toEqual({ status: "done", tx_hash: "ab".repeat(32), last_error: null });
    expect(summary).toMatchObject({ done: 1, pending: 0 });
  });

  it("reads the database role at run time: someone added back as editor keeps their on-chain role", async () => {
    const store = memoryStore([job({})], { [editorWallet]: "editor" });
    const revoker = chainWith({ [editorWallet]: "editor" });
    await processChainJobs(store, { ...base, editors: true, revoker, reassigner: null });
    expect(revoker.sent).toEqual([]);
    expect(store.finished.j1.status).toBe("done");
  });

  it("leaves revocations pending, with a reason, when this server has no revoker key", async () => {
    const store = memoryStore([job({ attempts: 2 })]);
    await processChainJobs(store, { ...base, editors: true, revoker: null, reassigner: null });
    expect(store.finished.j1).toMatchObject({ status: "pending", next_attempt_at: new Date(now.getTime() + retryDelayMs(2)).toISOString() });
    expect(store.finished.j1.last_error).toMatch(/REVOKER_SECRET_KEY/);
  });

  it("keeps a job whose sends keep failing pending, backing off by attempt", async () => {
    const store = memoryStore([job({ attempts: 3 })]);
    const revoker: RevokerChain = { readRole: async () => "editor", submit: async () => Promise.reject(new Error("RPC down")) };
    await processChainJobs(store, { ...base, editors: true, revoker, reassigner: null });
    expect(store.finished.j1).toMatchObject({ status: "pending", last_error: "RPC down" });
    expect(store.finished.j1.next_attempt_at).toBe(new Date(now.getTime() + 120_000).toISOString());
  });

  it("leaves another network's passkey wallet to that deployment", async () => {
    const store = memoryStore([job({ network: "mainnet" })]);
    const revoker = chainWith({ [editorWallet]: "editor" });
    await processChainJobs(store, { ...base, editors: true, revoker, reassigner: null });
    expect(revoker.sent).toEqual([]);
    expect(store.finished.j1.status).toBe("pending");
  });

  it("revokes a Stellar account (no network) on any deployment", async () => {
    const store = memoryStore([job({ address: adminWallet, network: null })]);
    const revoker = chainWith({ [adminWallet]: "admin" });
    await processChainJobs(store, { ...base, editors: true, revoker, reassigner: null });
    expect(revoker.sent).toEqual([`remove_admin:${adminWallet}`]);
  });

  it("marks a D-31 handover as needing the product owner without the contract admin key, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore([job({ id: "h", kind: "reassign_owner", user_id: "heir", address: null, network: null })]);
    const summary = await processChainJobs(store, { ...base, editors: true, revoker: null, reassigner: null });
    expect(store.finished.h.status).toBe("needs_product_owner");
    expect(summary.needsProductOwner).toBe(1);
    expect(store.reopened).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("needs_product_owner"));
    warn.mockRestore();
  });

  it("hands the workspace to the heir's wallet with the contract admin key (D-36), reopening waiting handovers", async () => {
    const store = memoryStore([job({ id: "h", kind: "reassign_owner", user_id: "heir", address: null })], {}, { heir: heirWallet });
    const calls: string[] = [];
    const reassigner: OwnerReassigner = {
      readOwner: async () => "GOLDOWNER",
      reassign: async (_ws, owner) => {
        calls.push(owner);
        return "cd".repeat(32);
      },
    };
    await processChainJobs(store, { ...base, editors: true, revoker: null, reassigner });
    expect(store.reopened).toBe(1);
    expect(calls).toEqual([heirWallet]);
    expect(store.finished.h).toMatchObject({ status: "done", tx_hash: "cd".repeat(32) });
  });

  it("finishes a handover the chain already agrees with without sending anything", async () => {
    const store = memoryStore([job({ id: "h", kind: "reassign_owner", user_id: "heir", address: null })], {}, { heir: heirWallet });
    const reassign = vi.fn();
    await processChainJobs(store, { ...base, editors: true, revoker: null, reassigner: { readOwner: async () => heirWallet, reassign } });
    expect(reassign).not.toHaveBeenCalled();
    expect(store.finished.h.status).toBe("done");
  });

  it("waits for an heir who has no wallet yet", async () => {
    const store = memoryStore([job({ id: "h", kind: "reassign_owner", user_id: "heir", address: null })]);
    const reassign = vi.fn();
    await processChainJobs(store, { ...base, editors: true, revoker: null, reassigner: { readOwner: async () => "G", reassign } });
    expect(store.finished.h).toMatchObject({ status: "pending", last_error: "The new owner has no wallet yet." });
  });

  it("records an unexpected error on the job and carries on with the next", async () => {
    const store = memoryStore([job({ id: "a" }), job({ id: "b", address: adminWallet, network: null })]);
    store.roleOfAddress = async (_ws, address) => {
      if (address === editorWallet) throw new Error("database down");
      return null;
    };
    const revoker = chainWith({ [adminWallet]: "admin" });
    await processChainJobs(store, { ...base, editors: true, revoker, reassigner: null });
    expect(store.finished.a).toMatchObject({ status: "pending", last_error: "database down" });
    expect(store.finished.b.status).toBe("done");
  });
});

describe("retryDelayMs", () => {
  it("doubles from 30 seconds and caps at an hour", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(40)).toBe(3_600_000);
  });
});
