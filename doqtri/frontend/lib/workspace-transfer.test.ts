import { describe, expect, it } from "vitest";
import { authorizeEntry, hash, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { acceptTransfer, type OpenTransfer, type TransferDeps } from "@/lib/workspace-transfer";
import { transferInvocation } from "@/lib/stellar/transfer-approval";
import type { WorkspaceRole } from "@/lib/workspace-roles";

const registry = StrKey.encodeContract(hash(Buffer.from("registry")));
const team = "7a000000-0000-4000-8000-0000000000d1";
const home = "7a000000-0000-4000-8000-0000000000d2";
const owner = Keypair.random();
const heir = Keypair.random();
const passphrase = "Test SDF Network ; September 2015";

async function approval(kp: Keypair, workspaceId = team, to = heir.publicKey()) {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: xdr.ScAddress.scAddressTypeAccount(kp.xdrAccountId()),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        transferInvocation(registry, workspaceId, owner.publicKey(), to),
      ),
      subInvocations: [],
    }),
  });
  return (await authorizeEntry(entry, kp, 500, passphrase)).toXDR("base64");
}

async function proposal(over: Partial<OpenTransfer> = {}): Promise<OpenTransfer> {
  return {
    workspace_id: team,
    from_user: "u-owner",
    to_user: "u-heir",
    owner_address: owner.publicKey(),
    new_owner_address: heir.publicKey(),
    owner_approval: await approval(owner),
    ...over,
  };
}

/** The chain and database as the route sees them; the database role changes when accepted. */
function deps(over: Partial<TransferDeps> & { chainOwner?: string | null } = {}) {
  const roles: Record<string, WorkspaceRole> = { "u-owner": "owner", "u-heir": "admin" };
  const wallets: Record<string, string> = { "u-owner": owner.publicKey(), "u-heir": heir.publicKey() };
  const log: string[] = [];
  const d: TransferDeps & { log: string[] } = {
    log,
    editors: true,
    registry,
    access: {
      workspace: async (id) => (id === team ? { personal: false } : id === home ? { personal: true } : null),
      addressRole: async (_ws, address) => {
        const user = Object.entries(wallets).find(([, a]) => a === address)?.[0];
        return user ? (roles[user] ?? null) : null;
      },
    },
    readChainOwner: async () => ("chainOwner" in over ? over.chainOwner! : owner.publicKey()),
    addressOf: async (userId) => wallets[userId] ?? null,
    async submit(func, auth) {
      log.push(`submit:${func.invokeContract().functionName().toString()}:${auth.length}`);
      return "ef".repeat(32);
    },
    async acceptInDatabase(_ws, userId) {
      log.push(`db:${userId}`);
      roles["u-heir"] = "owner";
      roles["u-owner"] = "admin";
      return "u-owner";
    },
    ...over,
  };
  return d;
}

describe("acceptTransfer (D-29)", () => {
  it("submits both owners' signatures, then moves the database, then asks for add_admin (D-35)", async () => {
    const d = deps();
    const result = await acceptTransfer(await proposal(), "u-heir", await approval(heir), d);
    expect(d.log).toEqual(["submit:transfer_workspace:2", "db:u-heir"]);
    expect(result).toEqual({
      txHash: "ef".repeat(32),
      followUp: { fn: "add_admin", workspaceId: team, subject: owner.publicKey() },
    });
  });

  it("only lets the named new owner accept", async () => {
    const d = deps();
    await expect(acceptTransfer(await proposal(), "u-owner", await approval(owner), d)).rejects.toThrow(/no open transfer/);
    await expect(acceptTransfer(null, "u-heir", undefined, d)).rejects.toThrow(/no open transfer/);
    expect(d.log).toEqual([]);
  });

  it("answers anyone else 404, even with the new owner's own signature, touching neither chain nor database", async () => {
    const d = deps();
    const heirSigned = await approval(heir);
    for (const caller of ["u-stranger", "u-owner"]) {
      await expect(acceptTransfer(await proposal(), caller, heirSigned, d)).rejects.toMatchObject({ name: "RelayRejection", status: 404 });
    }
    // Off-chain, where no signature is checked at all, still only the new owner.
    await expect(acceptTransfer(await proposal(), "u-stranger", undefined, deps({ editors: false }))).rejects.toMatchObject({ status: 404 });
    expect(d.log).toEqual([]);
  });

  it("refuses without the new owner's signature, touching neither chain nor database", async () => {
    const d = deps();
    await expect(acceptTransfer(await proposal(), "u-heir", undefined, d)).rejects.toThrow(/new owner's approval is missing/);
    expect(d.log).toEqual([]);
  });

  it("refuses an owner signature for a different transfer", async () => {
    const d = deps();
    const forged = await proposal({ owner_approval: await approval(owner, team, Keypair.random().publicKey()) });
    await expect(acceptTransfer(forged, "u-heir", await approval(heir), d)).rejects.toThrow(/owner's approval/);
    expect(d.log).toEqual([]);
  });

  it("asks the owner to propose again when an on-chain workspace was proposed without their signature", async () => {
    const d = deps();
    const unsigned = await proposal({ owner_address: null, new_owner_address: null, owner_approval: null });
    await expect(acceptTransfer(unsigned, "u-heir", await approval(heir), d)).rejects.toThrow(/propose it again/);
    expect(d.log).toEqual([]);
  });

  it("refuses when the caller's wallet is not the one the transfer names", async () => {
    const d = deps({ addressOf: async () => Keypair.random().publicKey() });
    await expect(acceptTransfer(await proposal(), "u-heir", await approval(heir), d)).rejects.toThrow(/different wallet/);
  });

  it("refuses when the workspace changed hands on-chain in between", async () => {
    const d = deps({ chainOwner: Keypair.random().publicKey() });
    await expect(acceptTransfer(await proposal(), "u-heir", await approval(heir), d)).rejects.toThrow(/changed hands/);
    expect(d.log).toEqual([]);
  });

  it("finishes the database step when an earlier accept already landed on-chain", async () => {
    const d = deps({ chainOwner: heir.publicKey() });
    const result = await acceptTransfer(await proposal(), "u-heir", undefined, d);
    expect(d.log).toEqual(["db:u-heir"]);
    expect(result.txHash).toBeNull();
    expect(result.followUp?.fn).toBe("add_admin");
  });

  it("never builds a transfer of a personal workspace (D-37)", async () => {
    const d = deps();
    const personal = await proposal({ workspace_id: home, owner_approval: await approval(owner, home) });
    await expect(acceptTransfer(personal, "u-heir", await approval(heir, home), d)).rejects.toThrow(/personal workspace/);
    expect(d.log).toEqual([]);
  });

  it("moves only the database, with no chain calls, while REGISTRY_EDITORS is off", async () => {
    const d = deps({ editors: false });
    const result = await acceptTransfer(await proposal({ owner_address: null, new_owner_address: null, owner_approval: null }), "u-heir", undefined, d);
    expect(d.log).toEqual(["db:u-heir"]);
    expect(result).toEqual({ txHash: null, followUp: null });
  });

  it("moves only the database for a workspace that is not on-chain yet", async () => {
    const d = deps({ chainOwner: null });
    const result = await acceptTransfer(await proposal(), "u-heir", undefined, d);
    expect(d.log).toEqual(["db:u-heir"]);
    expect(result.followUp).toBeNull();
  });
});
