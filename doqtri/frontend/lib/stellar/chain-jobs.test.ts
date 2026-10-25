import { describe, expect, it, vi } from "vitest";
import { hash, Keypair, StrKey } from "@stellar/stellar-sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  processChainJobs,
  retryDelayMs,
  supabaseChainJobStore,
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
  return { id: "j1", workspace_id: ws, kind: "revoke", user_id: "u", address: editorWallet, network: "testnet", attempts: 1, claim_token: "t1", ...over };
}

function memoryStore(jobs: ChainJob[], roles: Record<string, WorkspaceRole> = {}, wallets: Record<string, string> = {}) {
  const finished: Record<string, JobUpdate> = {};
  // Tokens the database no longer holds: the job was re-pointed (D-31) or claimed again.
  const voided = new Set<string>();
  const store: ChainJobStore & { finished: typeof finished; voided: typeof voided; claims: number; reopened: number } = {
    finished,
    voided,
    claims: 0,
    reopened: 0,
    async claim() {
      store.claims++;
      return jobs.splice(0);
    },
    async finish(job, update) {
      if (!job.claim_token || voided.has(job.claim_token)) return false;
      finished[job.id] = update;
      return true;
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

  it("leaves a handover re-pointed during its call open for the new heir (WP-1.10)", async () => {
    const nextHeirWallet = StrKey.encodeContract(hash(Buffer.from("next heir")));
    const claimed = job({ id: "h", kind: "reassign_owner", user_id: "heir", address: null, claim_token: "first" });
    const store = memoryStore([claimed], {}, { heir: heirWallet, next: nextHeirWallet });
    const owners: string[] = [];
    let chainOwner = "GOLDOWNER";
    const reassigner: OwnerReassigner = {
      readOwner: async () => chainOwner,
      reassign: async (_ws, owner) => {
        // The heir deletes their account while this call is in flight: the
        // database re-points the job to the next admin and clears its token.
        store.voided.add("first");
        owners.push(owner);
        chainOwner = owner;
        return "cd".repeat(32);
      },
    };
    const first = await processChainJobs(store, { ...base, editors: true, revoker: null, reassigner });
    expect(store.finished.h).toBeUndefined();
    expect(first).toMatchObject({ done: 0, pending: 1 });

    // The next run claims the re-pointed job and moves the chain on to the new heir.
    const again = memoryStore([{ ...claimed, user_id: "next", attempts: 1, claim_token: "second" }], {}, { next: nextHeirWallet });
    const summary = await processChainJobs(again, { ...base, editors: true, revoker: null, reassigner });
    expect(owners).toEqual([heirWallet, nextHeirWallet]);
    expect(again.finished.h).toMatchObject({ status: "done", tx_hash: "cd".repeat(32) });
    expect(summary.done).toBe(1);
  });

  it("leaves a revocation a removal was queued onto during its call open (WP-1.10 review)", async () => {
    // An admin demoted to editor: the run brings their on-chain role down to editor.
    const claimed = job({ address: adminWallet, network: null, claim_token: "first" });
    const roles: Record<string, WorkspaceRole> = { [adminWallet]: "editor" };
    const store = memoryStore([claimed], roles);
    const chain: Record<string, ChainRole> = { [adminWallet]: "admin" };
    const sent: string[] = [];
    const revoker: RevokerChain = {
      readRole: async (_ws, address) => chain[address] ?? null,
      async submit(fn, _ws, address) {
        // They are removed while this call is in flight: the removal's
        // revocation is queued onto this job and clears its token.
        delete roles[address];
        store.voided.add("first");
        sent.push(`${fn}:${address}`);
        chain[address] = fn === "remove_admin" ? "editor" : null;
        return "ab".repeat(32);
      },
    };
    const first = await processChainJobs(store, { ...base, editors: true, revoker, reassigner: null });
    expect(sent).toEqual([`remove_admin:${adminWallet}`]);
    expect(store.finished.j1).toBeUndefined();
    expect(first).toMatchObject({ done: 0, pending: 1 });

    // The next run reads the chain again and takes the editor role too.
    const again = memoryStore([{ ...claimed, claim_token: "second" }], roles);
    await processChainJobs(again, { ...base, editors: true, revoker, reassigner: null });
    expect(sent).toEqual([`remove_admin:${adminWallet}`, `remove_editor:${adminWallet}`]);
    expect(chain[adminWallet]).toBeNull();
    expect(again.finished.j1.status).toBe("done");
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

describe("supabaseChainJobStore.finish", () => {
  function adminReturning(result: { data: unknown; error: { message: string } | null }) {
    const calls: { update?: unknown; eq: [string, unknown][]; select?: string } = { eq: [] };
    const builder = {
      update(value: unknown) {
        calls.update = value;
        return builder;
      },
      eq(column: string, value: unknown) {
        calls.eq.push([column, value]);
        return builder;
      },
      select(columns: string) {
        calls.select = columns;
        return Promise.resolve(result);
      },
    };
    const from = vi.fn(() => builder);
    return { admin: { from } as unknown as SupabaseClient, calls, from };
  }
  const access = { addressRole: async () => null };

  it("updates the job by id and by the token its claim returned, releasing the token", async () => {
    const { admin, calls } = adminReturning({ data: [{ id: "j1" }], error: null });
    const store = supabaseChainJobStore(admin, "testnet", access);
    await expect(store.finish(job({ claim_token: "tok" }), { status: "done", last_error: null })).resolves.toBe(true);
    // And releases the claim as it records the outcome.
    expect(calls.update).toEqual({ status: "done", last_error: null, claim_token: null });
    expect(calls.eq).toEqual([["id", "j1"], ["claim_token", "tok"]]);
  });

  it("reports a job that changed since the claim as not recorded", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { admin } = adminReturning({ data: [], error: null });
    const store = supabaseChainJobStore(admin, "testnet", access);
    await expect(store.finish(job({}), { status: "done" })).resolves.toBe(false);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("changed since it was claimed"));
    info.mockRestore();
  });

  it("records nothing for a job without a claim token, or when the write fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const untokened = adminReturning({ data: [{ id: "j1" }], error: null });
    await expect(supabaseChainJobStore(untokened.admin, "testnet", access).finish(job({ claim_token: null }), { status: "done" })).resolves.toBe(false);
    expect(untokened.from).not.toHaveBeenCalled();
    const failing = adminReturning({ data: null, error: { message: "down" } });
    await expect(supabaseChainJobStore(failing.admin, "testnet", access).finish(job({}), { status: "done" })).resolves.toBe(false);
    error.mockRestore();
  });
});

describe("retryDelayMs", () => {
  it("doubles from 30 seconds and caps at an hour", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(40)).toBe(3_600_000);
  });
});
