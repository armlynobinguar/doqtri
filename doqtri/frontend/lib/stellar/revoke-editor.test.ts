import { describe, expect, it } from "vitest";
import { hash, StrKey } from "@stellar/stellar-sdk";
import { revokeOnChain, type RevokerChain } from "@/lib/stellar/revoke-editor";
import { ChainCallRefused } from "@/lib/stellar/server-signer";
import type { ChainRole } from "@/lib/stellar/workspace-chain";

const ws = "7a000000-0000-4000-8000-0000000000a1";
const member = StrKey.encodeContract(hash(Buffer.from("member-wallet")));
const txHash = (n: number) => n.toString(16).padStart(64, "0");
const noSleep = async () => {};

/**
 * A registry with one workspace and one member, which a removal changes the
 * way the contract does: remove_admin takes an admin out, remove_editor an
 * editor, and either is a no-op returning false for anyone else. `failures`
 * makes the next calls throw first, as a flaky RPC or an unconfirmed ledger
 * would.
 */
function fakeChain(start: ChainRole | "no_workspace", failures: { read?: unknown[]; submit?: unknown[] } = {}) {
  let role = start;
  const sent: string[] = [];
  const chain: RevokerChain & { sent: string[]; role: () => ChainRole | "no_workspace" } = {
    sent,
    role: () => role,
    async readRole() {
      const next = failures.read?.shift();
      if (next) throw next;
      return role;
    },
    async submit(fn) {
      const next = failures.submit?.shift();
      if (next) throw next;
      sent.push(fn);
      if (fn === "remove_admin" && role === "admin") role = null;
      if (fn === "remove_editor" && role === "editor") role = null;
      return txHash(sent.length);
    },
  };
  return chain;
}

describe("revokeOnChain (D-16)", () => {
  it("removes an editor the database removed, and confirms it on the ledger", async () => {
    const chain = fakeChain("editor");
    const outcome = await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain, { sleep: noSleep });
    expect(outcome).toEqual({ status: "done", txHash: txHash(1), calls: ["remove_editor"] });
    expect(chain.role()).toBeNull();
  });

  it("takes an admin out with remove_admin, whether removed or demoted to viewer", async () => {
    const chain = fakeChain("admin");
    const outcome = await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain, { sleep: noSleep });
    expect(outcome).toMatchObject({ status: "done", calls: ["remove_admin"] });
  });

  it("brings an admin demoted to editor down with remove_admin and stops: the editor grant is an admin's to sign", async () => {
    const chain = fakeChain("admin");
    const outcome = await revokeOnChain({ workspaceId: ws, address: member, allowed: "editor" }, chain, { sleep: noSleep });
    expect(outcome).toMatchObject({ status: "done", calls: ["remove_admin"] });
    expect(chain.sent).toEqual(["remove_admin"]);
  });

  it("is idempotent: a second run, or a member already gone, sends nothing", async () => {
    const chain = fakeChain("editor");
    await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain, { sleep: noSleep });
    const again = await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain, { sleep: noSleep });
    expect(again).toEqual({ status: "done", txHash: null, calls: [] });
    expect(chain.sent).toEqual(["remove_editor"]);
  });

  it("never takes away a role the database has given back since the job was queued", async () => {
    const chain = fakeChain("editor");
    const outcome = await revokeOnChain({ workspaceId: ws, address: member, allowed: "editor" }, chain, { sleep: noSleep });
    expect(outcome).toEqual({ status: "done", txHash: null, calls: [] });
    expect(chain.sent).toEqual([]);
  });

  it("does nothing for a workspace that is not on-chain", async () => {
    const chain = fakeChain("no_workspace");
    expect(await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain)).toMatchObject({ status: "done" });
    expect(chain.sent).toEqual([]);
  });

  it("retries a send that failed until the ledger confirms, backing off", async () => {
    const waits: number[] = [];
    const chain = fakeChain("editor", { submit: [new Error("txBadSeq"), new Error("not in a ledger yet")] });
    const outcome = await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain, {
      attempts: 3,
      delayMs: 100,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(outcome).toMatchObject({ status: "done", calls: ["remove_editor"] });
    expect(waits).toEqual([100, 200]);
  });

  it("retries a failed read", async () => {
    const chain = fakeChain("editor", { read: [new Error("RPC down")] });
    expect(await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain, { sleep: noSleep })).toMatchObject({
      status: "done",
      calls: ["remove_editor"],
    });
  });

  it("gives up for now after its attempts, leaving the job pending with the last error", async () => {
    const chain = fakeChain("editor", { submit: [new Error("a"), new Error("b"), new Error("c")] });
    const outcome = await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain, { attempts: 3, sleep: noSleep });
    expect(outcome).toEqual({ status: "retry", error: "c" });
    expect(chain.role()).toBe("editor");
  });

  it("keeps waiting while the registry has not been given this revoker (set_revoker)", async () => {
    const notRevoker = new ChainCallRefused("remove_editor would fail on-chain: Error(Contract, #9)", 9);
    const chain = fakeChain("editor", { submit: [notRevoker, notRevoker, notRevoker] });
    expect(await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain, { sleep: noSleep })).toMatchObject({
      status: "retry",
    });
  });

  it("stops for good on a refusal retrying cannot fix", async () => {
    const chain = fakeChain("editor", { submit: [new ChainCallRefused("Error(Contract, #11)", 11)] });
    expect(await revokeOnChain({ workspaceId: ws, address: member, allowed: null }, chain, { sleep: noSleep })).toMatchObject({
      status: "failed",
    });
    expect(chain.sent).toEqual([]);
  });

  it("refuses to touch the workspace's on-chain owner", async () => {
    const chain = fakeChain("owner");
    const outcome = await revokeOnChain({ workspaceId: ws, address: member, allowed: "admin" }, chain, { sleep: noSleep });
    expect(outcome.status).toBe("failed");
    expect(chain.sent).toEqual([]);
  });
});
