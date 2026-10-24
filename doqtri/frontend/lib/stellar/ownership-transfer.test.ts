import { describe, expect, it } from "vitest";
import { Address, hash, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { buildOwnershipTransfer, formerOwnerFollowUp } from "@/lib/stellar/ownership-transfer";
import { authorizeRegistryWrite, type RegistryAccess } from "@/lib/stellar/relay-validation";
import type { WorkspaceRole } from "@/lib/workspace-roles";

const contract = (seed: string) => StrKey.encodeContract(hash(Buffer.from(seed)));
const registry = contract("registry");
const team = "7a000000-0000-4000-8000-0000000000f1";
const home = "7a000000-0000-4000-8000-0000000000f2";
const missing = "7a000000-0000-4000-8000-0000000000ff";
const formerOwner = contract("former-owner-wallet");
const newOwner = contract("new-owner-wallet");
const editorWallet = Keypair.random().publicKey();

/**
 * The team just after the database side of a transfer: `new` owns it and
 * `former` stayed on as an admin (D-35). `home` is a personal workspace.
 */
const roles: Record<string, Record<string, WorkspaceRole>> = {
  [team]: { "u-new": "owner", "u-former": "admin", "u-editor": "editor" },
  [home]: { "u-former": "owner", "u-new": "admin" },
};
const walletUsers: Record<string, string> = { [formerOwner]: "u-former", [newOwner]: "u-new", [editorWallet]: "u-editor" };
const workspaces: Record<string, { personal: boolean }> = { [team]: { personal: false }, [home]: { personal: true } };

function accessWith(teamRoles = roles[team]): RegistryAccess & { lookups: string[] } {
  const lookups: string[] = [];
  const all: Record<string, Record<string, WorkspaceRole>> = { ...roles, [team]: teamRoles };
  return {
    lookups,
    documentWorkspace: async () => null,
    workspace: async (workspaceId) => {
      lookups.push(workspaceId);
      return workspaces[workspaceId] ?? null;
    },
    memberRole: async (workspaceId, userId) => all[workspaceId]?.[userId] ?? null,
    addressRole: async (workspaceId, address) => {
      const userId = walletUsers[address];
      return userId ? (all[workspaceId]?.[userId] ?? null) : null;
    },
  };
}

function invocation(func: xdr.HostFunction) {
  const invoke = func.invokeContract();
  return {
    contract: Address.fromScAddress(invoke.contractAddress()).toString(),
    fn: invoke.functionName().toString(),
    args: invoke.args().map((arg) =>
      arg.switch().name === "scvString" ? arg.str().toString() : Address.fromScAddress(arg.address()).toString(),
    ),
  };
}

describe("buildOwnershipTransfer (D-37)", () => {
  it("builds transfer_workspace for a team workspace, naming both owners", async () => {
    const func = await buildOwnershipTransfer(
      { fn: "transfer_workspace", workspaceId: team, owner: formerOwner, newOwner },
      accessWith(),
      registry,
    );
    expect(invocation(func)).toEqual({ contract: registry, fn: "transfer_workspace", args: [team, formerOwner, newOwner] });
  });

  it("builds admin_reassign_owner for a team workspace, naming only the new owner", async () => {
    const func = await buildOwnershipTransfer({ fn: "admin_reassign_owner", workspaceId: team, newOwner }, accessWith(), registry);
    expect(invocation(func)).toEqual({ contract: registry, fn: "admin_reassign_owner", args: [team, newOwner] });
  });

  it("refuses to build either call for a personal workspace (D-30)", async () => {
    for (const transfer of [
      { fn: "transfer_workspace" as const, workspaceId: home, owner: formerOwner, newOwner },
      { fn: "admin_reassign_owner" as const, workspaceId: home, newOwner },
    ]) {
      await expect(buildOwnershipTransfer(transfer, accessWith(), registry)).rejects.toMatchObject({
        name: "RelayRejection",
        status: 403,
        message: expect.stringMatching(/personal workspace stays with the person who created it/),
      });
    }
  });

  it("refuses a workspace doqtri doesn't know, and looks nothing up for one that isn't an id", async () => {
    await expect(
      buildOwnershipTransfer({ fn: "admin_reassign_owner", workspaceId: missing, newOwner }, accessWith(), registry),
    ).rejects.toMatchObject({ status: 404 });
    const access = accessWith();
    await expect(
      buildOwnershipTransfer({ fn: "admin_reassign_owner", workspaceId: "acme", newOwner }, access, registry),
    ).rejects.toMatchObject({ status: 400 });
    expect(access.lookups).toEqual([]);
  });

  it("refuses an owner that isn't an address", async () => {
    await expect(
      buildOwnershipTransfer({ fn: "transfer_workspace", workspaceId: team, owner: "alice", newOwner }, accessWith(), registry),
    ).rejects.toThrow(/current owner is not a Stellar address/);
    await expect(
      buildOwnershipTransfer({ fn: "admin_reassign_owner", workspaceId: team, newOwner: "bob" }, accessWith(), registry),
    ).rejects.toThrow(/new owner is not a Stellar address/);
  });
});

describe("formerOwnerFollowUp (D-35)", () => {
  it("asks for add_admin when the database kept the former owner as an admin", async () => {
    await expect(formerOwnerFollowUp(team, formerOwner, accessWith())).resolves.toEqual({
      fn: "add_admin",
      workspaceId: team,
      subject: formerOwner,
    });
  });

  it("asks for nothing when the database kept them as less than an admin, or not at all", async () => {
    for (const kept of ["editor", "viewer"] as const) {
      const access = accessWith({ "u-new": "owner", "u-former": kept });
      await expect(formerOwnerFollowUp(team, formerOwner, access)).resolves.toBeNull();
    }
    await expect(formerOwnerFollowUp(team, formerOwner, accessWith({ "u-new": "owner" }))).resolves.toBeNull();
  });

  it("asks for nothing while the database still has them as owner (its side of the transfer hasn't happened)", async () => {
    const access = accessWith({ "u-former": "owner", "u-new": "admin" });
    await expect(formerOwnerFollowUp(team, formerOwner, access)).resolves.toBeNull();
  });

  it("asks for nothing on a personal workspace, which is never transferred", async () => {
    await expect(formerOwnerFollowUp(home, formerOwner, accessWith())).resolves.toBeNull();
    await expect(formerOwnerFollowUp(missing, formerOwner, accessWith())).resolves.toBeNull();
  });

  it("produces a call the relay pays for when the new owner signs it, and refuses from anyone else", async () => {
    const access = accessWith();
    const followUp = await formerOwnerFollowUp(team, formerOwner, access);
    expect(followUp).not.toBeNull();
    await expect(authorizeRegistryWrite(followUp!, "u-new", access, true)).resolves.toBeUndefined();
    // The former owner, an admin now, can't restore themselves; nor can an editor.
    await expect(authorizeRegistryWrite(followUp!, "u-former", access, true)).rejects.toThrow(/Only a workspace owner/);
    await expect(authorizeRegistryWrite(followUp!, "u-editor", access, true)).rejects.toThrow(/Only a workspace owner/);
    // On the live registry there is no add_admin to call.
    await expect(authorizeRegistryWrite(followUp!, "u-new", access, false)).rejects.toThrow(/aren't enabled/);
  });
});
