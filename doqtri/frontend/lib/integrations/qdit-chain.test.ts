import { describe, expect, it, vi } from "vitest";
import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  decodeMilestoneRecord,
  nodeStatusForMilestone,
  parseQditArtifactRef,
  qditArtifactRef,
  qditChainRpcUrl,
  QditChainError,
  readMilestoneRecord,
  type SimulateCall,
} from "@/lib/integrations/qdit-chain";

/*
 * Reading qdit's milestone_proof (WP-2.8, D-04), the D-19 mapping and the
 * artifact_ref grammar (contract section 10). The RPC is a fake that answers
 * with real ScVals, built as the contract would return them.
 */

const CONTRACT = "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG";
const PROJECT = "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34";
const MILESTONE = "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61";
const CHAIN = { network: "testnet" as const, contractId: CONTRACT };

function recordScVal(overrides: { status?: string; version?: number; project?: string; milestone?: string } = {}) {
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  // Soroban maps are sorted by key.
  return xdr.ScVal.scvMap([
    entry("milestone_id", nativeToScVal(overrides.milestone ?? MILESTONE, { type: "string" })),
    entry("project_id", nativeToScVal(overrides.project ?? PROJECT, { type: "string" })),
    entry("proof_hash", xdr.ScVal.scvBytes(Buffer.alloc(32, 0xab))),
    entry("status", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(overrides.status ?? "Approved")])),
    entry("submitter", nativeToScVal("GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI", { type: "address" })),
    entry("timestamp", nativeToScVal(BigInt(1_792_843_000), { type: "u64" })),
    entry("version", nativeToScVal(overrides.version ?? 2, { type: "u32" })),
  ]);
}

const answering = (outcome: Awaited<ReturnType<SimulateCall>>) => vi.fn<SimulateCall>(async () => outcome);

describe("readMilestoneRecord", () => {
  it("reads get_milestone_status on the project's contract and network", async () => {
    const simulate = answering({ ledger: 812, retval: recordScVal() });
    const read = await readMilestoneRecord(CHAIN, PROJECT, MILESTONE, { simulate, rpcUrl: () => "https://rpc.test" });
    expect(read).toEqual({
      ledger: 812,
      record: {
        status: "Approved",
        version: 2,
        proofHash: "ab".repeat(32),
        submitter: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
        timestamp: 1_792_843_000,
      },
    });
    const call = simulate.mock.calls[0][0];
    expect(call).toMatchObject({
      rpcUrl: "https://rpc.test",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
      method: "get_milestone_status",
    });
    expect(call.args.map((a) => scValToNative(a))).toEqual([PROJECT, MILESTONE]);
  });

  it("answers no record for MilestoneNotFound (error #3)", async () => {
    const simulate = answering({ ledger: 9, error: "HostError: Error(Contract, #3)\n\nEvent log..." });
    expect(await readMilestoneRecord(CHAIN, PROJECT, MILESTONE, { simulate })).toEqual({ ledger: 9, record: null });
  });

  it("throws on the contract's other errors and on host failures", async () => {
    await expect(
      readMilestoneRecord(CHAIN, PROJECT, MILESTONE, { simulate: answering({ ledger: 9, error: "Error(Contract, #6)" }) }),
    ).rejects.toMatchObject({ kind: "contract" });
    await expect(
      readMilestoneRecord(CHAIN, PROJECT, MILESTONE, {
        simulate: answering({ ledger: 9, error: "HostError: Error(Storage, MissingValue)" }),
      }),
    ).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("passes on an unreachable RPC", async () => {
    const simulate = vi.fn<SimulateCall>(async () => {
      throw new QditChainError("unreachable", "down");
    });
    await expect(readMilestoneRecord(CHAIN, PROJECT, MILESTONE, { simulate })).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("refuses a record for another milestone, or one it can't read", async () => {
    for (const retval of [
      recordScVal({ milestone: "c81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61" }),
      recordScVal({ status: "Archived" }),
      recordScVal({ version: 0 }),
      xdr.ScVal.scvU32(1),
    ]) {
      await expect(
        readMilestoneRecord(CHAIN, PROJECT, MILESTONE, { simulate: answering({ ledger: 1, retval }) }),
      ).rejects.toMatchObject({ kind: "bad_response" });
    }
  });

  it("checks its input before touching the network", async () => {
    const simulate = answering({ ledger: 1, retval: recordScVal() });
    await expect(readMilestoneRecord({ network: "testnet", contractId: "CNOPE" }, PROJECT, MILESTONE, { simulate })).rejects.toMatchObject({ kind: "invalid" });
    await expect(readMilestoneRecord(CHAIN, PROJECT.toUpperCase(), MILESTONE, { simulate })).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      readMilestoneRecord({ network: "futurenet" as never, contractId: CONTRACT }, PROJECT, MILESTONE, { simulate }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(simulate).not.toHaveBeenCalled();
  });

  it("decodes every status", () => {
    for (const status of ["Proposed", "Submitted", "Approved", "Rejected"]) {
      const native = scValToNative(recordScVal({ status }));
      expect(decodeMilestoneRecord(native, { projectId: PROJECT, milestoneId: MILESTONE }).status).toBe(status);
    }
  });
});

describe("qditChainRpcUrl", () => {
  it("takes the per-network override, else a default for the network", () => {
    expect(qditChainRpcUrl("testnet", { QDIT_CHAIN_RPC_URL_TESTNET: " https://my-rpc.test " } as never)).toBe("https://my-rpc.test");
    expect(qditChainRpcUrl("testnet", {} as never)).toBe("https://soroban-testnet.stellar.org");
    expect(qditChainRpcUrl("mainnet", {} as never)).toBe("https://mainnet.sorobanrpc.com");
    expect(qditChainRpcUrl("mainnet", { QDIT_CHAIN_RPC_URL_MAINNET: "https://main.test" } as never)).toBe("https://main.test");
  });
});

describe("D-19", () => {
  it("maps the chain's status to a node status", () => {
    expect(nodeStatusForMilestone(null)).toBe("Planned");
    expect(nodeStatusForMilestone("Proposed")).toBe("Planned");
    expect(nodeStatusForMilestone("Submitted")).toBe("Built");
    expect(nodeStatusForMilestone("Approved")).toBe("Verified");
    expect(nodeStatusForMilestone("Rejected")).toBe("Building");
  });
});

describe("artifact_ref (section 10)", () => {
  const ref = { network: "testnet" as const, contractId: CONTRACT, projectId: PROJECT, milestoneId: MILESTONE, version: 2 };

  it("writes the contract's example exactly", () => {
    expect(qditArtifactRef(ref)).toBe(
      "qdit:testnet:CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG:3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34/b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61@v2",
    );
    expect(parseQditArtifactRef(qditArtifactRef(ref))).toEqual(ref);
  });

  it("refuses what the grammar refuses", () => {
    expect(() => qditArtifactRef({ ...ref, version: 0 })).toThrow(QditChainError);
    expect(() => qditArtifactRef({ ...ref, version: 4_294_967_296 })).toThrow(QditChainError);
    expect(() => qditArtifactRef({ ...ref, projectId: PROJECT.toUpperCase() })).toThrow(QditChainError);
    expect(() => qditArtifactRef({ ...ref, network: "futurenet" as never })).toThrow(QditChainError);
    expect(parseQditArtifactRef(qditArtifactRef(ref).replace("@v2", "@v02"))).toBeNull();
    expect(parseQditArtifactRef(qditArtifactRef(ref).replace("qdit:", "QDIT:"))).toBeNull();
    // A well-formed StrKey shape with a bad checksum.
    expect(parseQditArtifactRef(qditArtifactRef(ref).replace("OHVG", "OHVA"))).toBeNull();
  });
});
