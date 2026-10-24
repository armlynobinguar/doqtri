import { Address, hash, Keypair, nativeToScVal, Networks, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  authorizeRegistryWrite,
  deployedContractAddress,
  deployerAddress,
  parseRelayBody,
  RelayRejection,
  validateForwardedWrite,
  validateRegistryWrite,
  validateWalletAdmin,
  validateWalletDeploy,
  type NoteWorkspace,
  type RegistryAccess,
  type RegistryWrite,
  type RelaySubmission,
} from "./relay-validation";
import type { WorkspaceRole } from "@/lib/workspace-roles";

const contract = (seed: string) => StrKey.encodeContract(hash(Buffer.from(seed)));

const expected = {
  accountWasmHash: "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a",
  webauthnVerifier: contract("verifier"),
  thresholdPolicy: contract("policy"),
  deployer: deployerAddress("openzeppelin-smart-account-kit"),
};

const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]);
const credentialId = Buffer.from("credential-id-bytes");

type Overrides = {
  wasmHash?: string;
  deployer?: string;
  salt?: Buffer;
  verifier?: string;
  keyData?: Buffer;
  signerKind?: string;
  extraSigner?: boolean;
  policies?: xdr.ScMapEntry[];
  authSigner?: string;
  authCount?: number;
};

function thresholdPolicy(address: string, threshold: number): xdr.ScMapEntry {
  return new xdr.ScMapEntry({
    key: Address.fromString(address).toScVal(),
    val: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("threshold"), val: xdr.ScVal.scvU32(threshold) }),
    ]),
  });
}

function build(o: Overrides = {}): RelaySubmission {
  const signer = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol(o.signerKind ?? "External"),
    Address.fromString(o.verifier ?? expected.webauthnVerifier).toScVal(),
    xdr.ScVal.scvBytes(o.keyData ?? Buffer.concat([publicKey, credentialId])),
  ]);
  const deploy = new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: Address.fromString(o.deployer ?? expected.deployer).toScAddress(),
        salt: o.salt ?? hash(credentialId),
      }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(
      Buffer.from(o.wasmHash ?? expected.accountWasmHash, "hex"),
    ),
    constructorArgs: [
      xdr.ScVal.scvVec(o.extraSigner ? [signer, signer] : [signer]),
      xdr.ScVal.scvMap(o.policies ?? [thresholdPolicy(expected.thresholdPolicy, 1)]),
    ],
  });
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(o.authSigner ?? expected.deployer).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(deploy),
      subInvocations: [],
    }),
  });
  return {
    func: xdr.HostFunction.hostFunctionTypeCreateContractV2(deploy),
    auth: Array.from({ length: o.authCount ?? 1 }, () => entry),
  };
}

function rejects(submission: RelaySubmission, message: RegExp) {
  expect(() => validateWalletDeploy(submission, expected)).toThrow(message);
}

describe("wallet deploy validation", () => {
  it("accepts the kit's deploy shape and extracts the passkey", () => {
    const result = validateWalletDeploy(build(), expected);
    expect(result.publicKey.equals(publicKey)).toBe(true);
    expect(result.credentialId.equals(credentialId)).toBe(true);
    expect(result.deployer).toBe(expected.deployer);
  });

  it("round-trips through the base64 body the relay receives", () => {
    const { func, auth } = build();
    const parsed = parseRelayBody({ func: func.toXDR("base64"), auth: auth.map((a) => a.toXDR("base64")) });
    expect(validateWalletDeploy(parsed, expected).credentialId.equals(credentialId)).toBe(true);
  });

  it("rejects other wasm, deployers, and salts", () => {
    rejects(build({ wasmHash: "00".repeat(32) }), /canonical smart-account wasm/);
    rejects(build({ deployer: Keypair.random().publicKey() }), /shared deployer/);
    rejects(build({ salt: hash(Buffer.from("other")) }), /salt does not match/);
  });

  it("rejects signers that are not one passkey on the canonical verifier", () => {
    rejects(build({ verifier: contract("attacker-verifier") }), /canonical WebAuthn verifier/);
    rejects(build({ signerKind: "Delegated" }), /exactly one External signer/);
    rejects(build({ extraSigner: true }), /exactly one External signer/);
    rejects(build({ keyData: publicKey }), /not a WebAuthn public key/);
  });

  it("requires exactly the threshold-1 policy", () => {
    rejects(build({ policies: [] }), /threshold-1 policy/);
    rejects(build({ policies: [thresholdPolicy(expected.thresholdPolicy, 2)] }), /threshold-1 policy/);
    rejects(build({ policies: [thresholdPolicy(contract("other-policy"), 1)] }), /threshold-1 policy/);
  });

  it("requires one auth entry signed by the deployer for exactly this deploy", () => {
    rejects(build({ authCount: 2 }), /exactly one auth entry/);
    rejects(build({ authSigner: Keypair.random().publicKey() }), /does not exactly match/);
    const swapped = build();
    swapped.auth = build({ salt: hash(Buffer.from("x")) }).auth;
    rejects(swapped, /does not exactly match/);
  });

  it("rejects anything that is not a deploy", () => {
    const invoke = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract("x")).toScAddress(),
        functionName: "transfer",
        args: [nativeToScVal(1)],
      }),
    );
    expect(() => validateWalletDeploy({ func: invoke, auth: build().auth }, expected)).toThrow(RelayRejection);
  });
});

describe("relay body parsing", () => {
  it("accepts only { func, auth }", () => {
    expect(() => parseRelayBody({ xdr: "AAAA" })).toThrow(/Only \{ func, auth \}/);
    expect(() => parseRelayBody({ func: "AAAA" })).toThrow(/func and auth/);
    expect(() => parseRelayBody({ func: "not-xdr", auth: ["also-not"] })).toThrow(/invalid XDR/);
    expect(() => parseRelayBody([])).toThrow(/JSON object/);
  });
});

describe("deployed contract address", () => {
  it("is deterministic per deployer, salt, and network", () => {
    const salt = hash(credentialId);
    const testnet = deployedContractAddress(expected.deployer, salt, Networks.TESTNET);
    expect(testnet).toMatch(/^C[A-Z2-7]{55}$/);
    expect(deployedContractAddress(expected.deployer, salt, Networks.TESTNET)).toBe(testnet);
    expect(deployedContractAddress(expected.deployer, salt, Networks.PUBLIC)).not.toBe(testnet);
  });
});

describe("registry write validation", () => {
  const registry = contract("registry");
  const wallet = contract("wallet");
  const docId = "3f1c2a9e-0000-4000-8000-000000000001";
  const str = (s: string) => xdr.ScVal.scvString(s);
  const hash32 = xdr.ScVal.scvBytes(Buffer.alloc(32, 1));
  const status = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Built")]);

  function call(fn: string, args: xdr.ScVal[], o: { target?: string; signer?: string; nested?: boolean; entries?: number } = {}) {
    const invoke = new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(o.target ?? registry).toScAddress(),
      functionName: fn,
      args,
    });
    const root = (inv: xdr.InvokeContractArgs, children: xdr.SorobanAuthorizedInvocation[] = []) =>
      new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(inv),
        subInvocations: children,
      });
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(o.signer ?? wallet).toScAddress(),
          nonce: xdr.Int64.fromString("7"),
          signatureExpirationLedger: 100,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: root(invoke, o.nested ? [root(invoke)] : []),
    });
    return {
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(invoke),
      auth: Array.from({ length: o.entries ?? 1 }, () => entry),
    };
  }

  const register = (owner = wallet, o = {}) =>
    call("register_document", [Address.fromString(owner).toScVal(), str(docId), hash32], o);
  const check = (s: RelaySubmission) => validateRegistryWrite(s, { registry, wallet });

  it("accepts the three registry writes and reports the document", () => {
    expect(check(register())).toEqual({ fn: "register_document", docId });
    expect(check(call("update_document", [str(docId), hash32]))).toEqual({ fn: "update_document", docId });
    expect(check(call("set_node_status", [str(docId), str("h1"), status, str("gh"), str("pr#1")]))).toEqual({
      fn: "set_node_status",
      docId,
    });
  });

  // NodeUpdate as the SDK encodes a struct: an ScMap with its fields in name order.
  const nodeUpdate = (fields: [string, xdr.ScVal][] = [
    ["artifact_ref", str("v1")],
    ["node_id", str("root")],
    ["status", status],
    ["tool", str("doqtri-done")],
  ]) => xdr.ScVal.scvMap(fields.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })));
  const anchor = (nodes: xdr.ScVal[] = [nodeUpdate()], owner = wallet) =>
    call("anchor", [Address.fromString(owner).toScVal(), str(docId), hash32, xdr.ScVal.scvVec(nodes)]);

  it("accepts anchor from your own wallet with up to 32 node updates", () => {
    expect(check(anchor())).toEqual({ fn: "anchor", docId });
    expect(check(anchor([]))).toEqual({ fn: "anchor", docId });
    expect(check(anchor(Array.from({ length: 32 }, () => nodeUpdate())))).toEqual({ fn: "anchor", docId });
  });

  it("refuses anchor for someone else's wallet, too many nodes, or malformed nodes", () => {
    expect(() => check(anchor([nodeUpdate()], contract("victim")))).toThrow(/name your wallet/);
    expect(() => check(anchor(Array.from({ length: 33 }, () => nodeUpdate())))).toThrow(/at most 32/);
    // A missing field, an extra field, a wrong type, fields out of order, not a struct.
    expect(() => check(anchor([nodeUpdate([["node_id", str("root")]])]))).toThrow(/at most 32/);
    expect(() =>
      check(anchor([nodeUpdate([
        ["artifact_ref", str("v1")], ["extra", str("x")], ["node_id", str("root")], ["status", status], ["tool", str("t")],
      ])])),
    ).toThrow(/at most 32/);
    expect(() =>
      check(anchor([nodeUpdate([["artifact_ref", str("v1")], ["node_id", str("root")], ["status", str("Built")], ["tool", str("t")]])])),
    ).toThrow(/at most 32/);
    expect(() =>
      check(anchor([nodeUpdate([["node_id", str("root")], ["artifact_ref", str("v1")], ["status", status], ["tool", str("t")]])])),
    ).toThrow(/at most 32/);
    expect(() => check(anchor([str("root")]))).toThrow(/at most 32/);
    // The nodes argument must be a list.
    expect(() =>
      check(call("anchor", [Address.fromString(wallet).toScVal(), str(docId), hash32, str("nodes")])),
    ).toThrow(/at most 32/);
  });

  it("refuses other contracts and functions", () => {
    expect(() => check(register(wallet, { target: contract("token") }))).toThrow(/Only the Doqtri registry/);
    expect(() => check(call("transfer", [str(docId), hash32]))).toThrow(/not allowed/);
  });

  it("refuses registering for someone else's wallet", () => {
    expect(() => check(register(contract("victim")))).toThrow(/name your wallet/);
  });

  it("refuses wrong argument shapes", () => {
    expect(() => check(call("update_document", [str(docId), xdr.ScVal.scvBytes(Buffer.alloc(31))]))).toThrow(/invalid argument/);
    expect(() => check(call("set_node_status", [str(docId), str("h1"), str("Built"), str(""), str("")]))).toThrow(/invalid argument/);
  });

  it("requires exactly one auth entry from the wallet for exactly this call", () => {
    expect(() => check(register(wallet, { signer: contract("other") }))).toThrow(/from your wallet/);
    expect(() => check(register(wallet, { nested: true }))).toThrow(/from your wallet/);
    expect(() => check(register(wallet, { entries: 2 }))).toThrow(/exactly one auth entry/);
    const mismatched = register();
    mismatched.auth = call("update_document", [str(docId), hash32]).auth;
    expect(() => check(mismatched)).toThrow(/from your wallet/);
  });

  // ---- v3 (WP-1.3): writes that name their signer, and workspaces ----
  const workspaceId = "7a000000-0000-4000-8000-0000000000a1";
  const addr = (a: string) => Address.fromString(a).toScVal();
  const member = contract("member");

  it("accepts the *_as writes from your own wallet and reports the note", () => {
    expect(check(call("anchor_as", [addr(wallet), str(docId), hash32, xdr.ScVal.scvVec([nodeUpdate()])]))).toEqual({
      fn: "anchor_as",
      docId,
    });
    expect(check(call("anchor_as", [addr(wallet), str(docId), hash32, xdr.ScVal.scvVec([])]))).toEqual({ fn: "anchor_as", docId });
    expect(check(call("update_document_as", [addr(wallet), str(docId), hash32]))).toEqual({ fn: "update_document_as", docId });
    expect(
      check(call("set_node_status_as", [addr(wallet), str(docId), str("h1"), status, str("gh"), str("pr#1")])),
    ).toEqual({ fn: "set_node_status_as", docId });
  });

  it("refuses *_as writes naming someone else as the signer", () => {
    const victim = contract("victim");
    expect(() => check(call("anchor_as", [addr(victim), str(docId), hash32, xdr.ScVal.scvVec([])]))).toThrow(
      /anchor_as must name your wallet as the signer/,
    );
    expect(() => check(call("update_document_as", [addr(victim), str(docId), hash32]))).toThrow(/name your wallet/);
    expect(() =>
      check(call("set_node_status_as", [addr(victim), str(docId), str("h1"), status, str(""), str("")])),
    ).toThrow(/name your wallet/);
  });

  it("applies anchor's node rules to anchor_as and the shape rules to the other *_as writes", () => {
    const tooMany = xdr.ScVal.scvVec(Array.from({ length: 33 }, () => nodeUpdate()));
    expect(() => check(call("anchor_as", [addr(wallet), str(docId), hash32, tooMany]))).toThrow(/at most 32/);
    expect(() => check(call("anchor_as", [addr(wallet), str(docId), hash32, xdr.ScVal.scvVec([str("x")])]))).toThrow(/at most 32/);
    // The owner-only shape (no signer) is not an *_as call.
    expect(() => check(call("update_document_as", [str(docId), hash32]))).toThrow(/invalid argument/);
    expect(() => check(call("update_document_as", [addr(wallet), str(docId), xdr.ScVal.scvBytes(Buffer.alloc(31))]))).toThrow(
      /invalid argument/,
    );
    expect(() => check(call("set_node_status_as", [addr(wallet), str(docId), str("h1"), str("Built"), str(""), str("")]))).toThrow(
      /invalid argument/,
    );
  });

  it("accepts assigning a note to a workspace and taking it out", () => {
    expect(check(call("assign_document", [str(docId), str(workspaceId)]))).toEqual({ fn: "assign_document", docId, workspaceId });
    expect(check(call("unassign_document", [str(docId)]))).toEqual({ fn: "unassign_document", docId });
    // Workspace ids are app workspace ids.
    expect(() => check(call("assign_document", [str(docId), str("acme")]))).toThrow(/invalid argument/);
    expect(() => check(call("unassign_document", [str(docId), str(workspaceId)]))).toThrow(/invalid argument/);
  });

  it("accepts membership writes from your own wallet and reports the workspace and member", () => {
    expect(check(call("create_workspace", [str(workspaceId), addr(wallet)]))).toEqual({
      fn: "create_workspace",
      workspaceId,
      subject: null,
    });
    for (const fn of ["add_editor", "remove_editor", "add_admin", "remove_admin"]) {
      expect(check(call(fn, [str(workspaceId), addr(wallet), addr(member)]))).toEqual({ fn, workspaceId, subject: member });
    }
  });

  it("refuses membership writes for someone else's wallet or with a bad shape", () => {
    const victim = contract("victim");
    expect(() => check(call("create_workspace", [str(workspaceId), addr(victim)]))).toThrow(/name your wallet as the owner/);
    expect(() => check(call("add_editor", [str(workspaceId), addr(victim), addr(member)]))).toThrow(/name your wallet as the admin/);
    expect(() => check(call("add_admin", [str(workspaceId), addr(victim), addr(member)]))).toThrow(/name your wallet as the owner/);
    expect(() => check(call("remove_editor", [str(workspaceId), addr(victim), addr(member)]))).toThrow(/name your wallet as the caller/);
    expect(() => check(call("add_editor", [str("acme"), addr(wallet), addr(member)]))).toThrow(/invalid argument/);
    expect(() => check(call("add_editor", [str(workspaceId), addr(wallet), str("member")]))).toThrow(/invalid argument/);
  });

  it("never relays the calls that need two owners or a server key", () => {
    for (const fn of ["transfer_workspace", "admin_reassign_owner", "set_revoker", "upgrade", "import_document", "import_node"]) {
      expect(() => check(call(fn, [str(workspaceId), addr(wallet), addr(member)]))).toThrow(/not allowed/);
    }
  });

  it("requires the v3 writes to carry exactly one approval from your wallet", () => {
    const assign = () => call("assign_document", [str(docId), str(workspaceId)]);
    expect(() => check(call("assign_document", [str(docId), str(workspaceId)], { signer: member }))).toThrow(/from your wallet/);
    expect(() => check(call("add_editor", [str(workspaceId), addr(wallet), addr(member)], { entries: 2 }))).toThrow(
      /exactly one auth entry/,
    );
    const mismatched = assign();
    mismatched.auth = call("unassign_document", [str(docId)]).auth;
    expect(() => check(mismatched)).toThrow(/from your wallet/);
  });
});

describe("registry write authorization (workspace roles)", () => {
  const team = "7a000000-0000-4000-8000-0000000000b1";
  const other = "7a000000-0000-4000-8000-0000000000b2";
  const home = "7a000000-0000-4000-8000-0000000000b3";
  const note = "3f1c2a9e-0000-4000-8000-0000000000b1";
  const homeNote = "3f1c2a9e-0000-4000-8000-0000000000b2";
  const orphanNote = "3f1c2a9e-0000-4000-8000-0000000000b3";
  const users = {
    owner: "u-owner",
    admin: "u-admin",
    editor: "u-editor",
    author: "u-author",
    viewer: "u-viewer",
    removed: "u-removed",
    outsider: "u-outsider",
  };
  const editorWallet = contract("editor-wallet");
  const viewerWallet = contract("viewer-wallet");
  const strangerWallet = contract("stranger-wallet");

  /**
   * The team as doqtri's database has it. `removed` was an editor and has
   * just been removed in the app: no membership row, even though the chain
   * may still list their wallet (D-16). `home` is the owner's personal
   * workspace, which took the editor as a member (D-30).
   */
  const roles: Record<string, Record<string, WorkspaceRole>> = {
    [team]: {
      [users.owner]: "owner",
      [users.admin]: "admin",
      [users.editor]: "editor",
      [users.author]: "editor",
      [users.viewer]: "viewer",
    },
    [other]: { [users.outsider]: "owner" },
    [home]: { [users.owner]: "owner", [users.admin]: "admin", [users.editor]: "editor", [users.viewer]: "viewer" },
  };
  const notes: Record<string, NoteWorkspace> = {
    // Written by `author`, an editor of the team.
    [note]: { workspaceId: team, personal: false, creatorId: users.author },
    [homeNote]: { workspaceId: home, personal: true, creatorId: users.owner },
    // Its author deleted their account.
    [orphanNote]: { workspaceId: team, personal: false, creatorId: null },
  };
  const walletUsers: Record<string, string> = { [editorWallet]: users.editor, [viewerWallet]: users.viewer };
  const access: RegistryAccess = {
    documentWorkspace: async (docId) => notes[docId] ?? null,
    memberRole: async (workspaceId, userId) => roles[workspaceId]?.[userId] ?? null,
    addressRole: async (workspaceId, address) => {
      const userId = walletUsers[address];
      return userId ? (roles[workspaceId]?.[userId] ?? null) : null;
    },
  };
  /** Defaults to REGISTRY_EDITORS on: the v3 registry. */
  const authorize = (write: RegistryWrite, userId: string, editors = true) =>
    authorizeRegistryWrite(write, userId, access, editors);
  const ownerOnly = (docId: string): RegistryWrite[] => [
    { fn: "anchor", docId },
    { fn: "update_document", docId },
    { fn: "set_node_status", docId },
    { fn: "register_document", docId },
  ];
  const editorWrites = (docId: string): RegistryWrite[] => [
    { fn: "anchor_as", docId },
    { fn: "update_document_as", docId },
    { fn: "set_node_status_as", docId },
    { fn: "assign_document", docId, workspaceId: team },
  ];
  const noteWrites = [...editorWrites(note), ...ownerOnly(note)];

  it("lets an editor, admin or owner sign every *_as write on a team note", async () => {
    for (const userId of [users.editor, users.admin, users.owner]) {
      for (const write of editorWrites(note)) await expect(authorize(write, userId)).resolves.toBeUndefined();
    }
  });

  it("refuses a viewer: viewers read, they never sign (D-14)", async () => {
    for (const editors of [true, false]) {
      for (const write of [...ownerOnly(note), ...ownerOnly(homeNote)]) {
        await expect(authorize(write, users.viewer, editors)).rejects.toThrow(/Viewers can read this note but not sign/);
      }
    }
    for (const write of editorWrites(note)) {
      await expect(authorize(write, users.viewer)).rejects.toThrow(/Viewers can read this note but not sign/);
    }
  });

  it("refuses a removed member at once, as if the note were not there (D-16)", async () => {
    for (const write of noteWrites) {
      await expect(authorize(write, users.removed)).rejects.toThrow(RelayRejection);
      await expect(authorize(write, users.removed)).rejects.toThrow(/isn't in your vault/);
    }
    for (const write of ownerOnly(note)) {
      await expect(authorize(write, users.removed, false)).rejects.toThrow(/isn't in your vault/);
    }
  });

  it("refuses an outsider, even one who owns another workspace", async () => {
    for (const write of noteWrites) await expect(authorize(write, users.outsider)).rejects.toThrow(/isn't in your vault/);
    for (const write of ownerOnly(homeNote)) {
      await expect(authorize(write, users.outsider, false)).rejects.toThrow(/isn't in your vault/);
    }
  });

  it("refuses a note that does not exist", async () => {
    await expect(authorize({ fn: "anchor_as", docId: "3f1c2a9e-0000-4000-8000-0000000000ff" }, users.owner)).rejects.toThrow(
      /isn't in your vault/,
    );
  });

  it("refuses a team note's owner-only writes once the *_as calls exist, so no editor takes the note over", async () => {
    for (const userId of [users.author, users.editor, users.admin, users.owner]) {
      for (const write of ownerOnly(note)) {
        await expect(authorize(write, userId)).rejects.toThrow(/written through the workspace calls/);
      }
    }
  });

  it("on the live registry, lets only a team note's author or the workspace owner sign it", async () => {
    for (const userId of [users.author, users.owner]) {
      for (const write of ownerOnly(note)) await expect(authorize(write, userId, false)).resolves.toBeUndefined();
    }
    // Anchoring first would make them its on-chain owner (registry v2).
    for (const userId of [users.editor, users.admin]) {
      for (const write of ownerOnly(note)) {
        await expect(authorize(write, userId, false)).rejects.toThrow(/Only this note's author or its workspace owner/);
      }
    }
    // With its author gone, only the owner.
    await expect(authorize({ fn: "anchor", docId: orphanNote }, users.owner, false)).resolves.toBeUndefined();
    await expect(authorize({ fn: "anchor", docId: orphanNote }, users.editor, false)).rejects.toThrow(
      /Only this note's author or its workspace owner/,
    );
  });

  it("refuses every v3 call while the registry has none of them", async () => {
    const v3: RegistryWrite[] = [
      ...editorWrites(note),
      { fn: "unassign_document", docId: note },
      { fn: "create_workspace", workspaceId: team, subject: null },
      { fn: "add_editor", workspaceId: team, subject: editorWallet },
      { fn: "remove_editor", workspaceId: team, subject: editorWallet },
      { fn: "add_admin", workspaceId: team, subject: editorWallet },
      { fn: "remove_admin", workspaceId: team, subject: editorWallet },
    ];
    for (const write of v3) {
      await expect(authorize(write, users.owner, false)).rejects.toThrow(/aren't enabled on this registry yet/);
    }
  });

  it("lets only the owner of a personal workspace write its notes, even with editor members (D-30)", async () => {
    for (const editors of [true, false]) {
      for (const write of ownerOnly(homeNote)) await expect(authorize(write, users.owner, editors)).resolves.toBeUndefined();
      for (const userId of [users.editor, users.admin]) {
        for (const write of ownerOnly(homeNote)) {
          await expect(authorize(write, userId, editors)).rejects.toThrow(/Only the owner of a personal workspace/);
        }
      }
    }
    for (const write of editorWrites(homeNote).slice(0, 3)) {
      await expect(authorize(write, users.editor)).rejects.toThrow(/Only the owner of a personal workspace/);
    }
  });

  it("never assigns a personal workspace's note on-chain", async () => {
    await expect(authorize({ fn: "assign_document", docId: homeNote, workspaceId: home }, users.owner)).rejects.toThrow(
      /aren't put in a workspace on-chain/,
    );
  });

  it("assigns a note only to the workspace it belongs to", async () => {
    await expect(authorize({ fn: "assign_document", docId: note, workspaceId: other }, users.editor)).rejects.toThrow(
      /only be assigned to the workspace it belongs to/,
    );
  });

  it("lets only an owner take a note out of its workspace", async () => {
    await expect(authorize({ fn: "unassign_document", docId: note }, users.owner)).resolves.toBeUndefined();
    for (const userId of [users.admin, users.editor]) {
      await expect(authorize({ fn: "unassign_document", docId: note }, userId)).rejects.toThrow(/Only an owner/);
    }
  });

  it("lets admins add and remove editors, and only editors be added", async () => {
    const add = (subject: string): RegistryWrite => ({ fn: "add_editor", workspaceId: team, subject });
    await expect(authorize(add(editorWallet), users.admin)).resolves.toBeUndefined();
    await expect(authorize(add(editorWallet), users.owner)).resolves.toBeUndefined();
    await expect(authorize(add(editorWallet), users.editor)).rejects.toThrow(/Only a workspace admin/);
    await expect(authorize(add(editorWallet), users.removed)).rejects.toThrow(/aren't a member/);
    // A viewer never gets chain write access, nor does a wallet nobody in the workspace holds.
    await expect(authorize(add(viewerWallet), users.admin)).rejects.toThrow(/Only a workspace editor/);
    await expect(authorize(add(strangerWallet), users.admin)).rejects.toThrow(/Only a workspace editor/);
    // Removing is always allowed to an admin, whoever the member is.
    await expect(
      authorize({ fn: "remove_editor", workspaceId: team, subject: strangerWallet }, users.admin),
    ).resolves.toBeUndefined();
  });

  it("lets only the owner manage admins and create the workspace on-chain", async () => {
    await expect(authorize({ fn: "add_admin", workspaceId: team, subject: editorWallet }, users.owner)).rejects.toThrow(
      /Only a workspace admin can be made an admin/,
    );
    await expect(authorize({ fn: "remove_admin", workspaceId: team, subject: editorWallet }, users.owner)).resolves.toBeUndefined();
    await expect(authorize({ fn: "remove_admin", workspaceId: team, subject: editorWallet }, users.admin)).rejects.toThrow(
      /Only a workspace owner/,
    );
    await expect(authorize({ fn: "create_workspace", workspaceId: team, subject: null }, users.owner)).resolves.toBeUndefined();
    await expect(authorize({ fn: "create_workspace", workspaceId: team, subject: null }, users.admin)).rejects.toThrow(
      /Only a workspace owner/,
    );
    await expect(authorize({ fn: "create_workspace", workspaceId: team, subject: null }, users.outsider)).rejects.toThrow(
      /aren't a member/,
    );
  });
});

describe("wallet admin validation (passkey changes)", () => {
  const wallet = contract("wallet");
  const verifier = expected.webauthnVerifier;
  const keyData = Buffer.concat([publicKey, Buffer.from("backup-credential")]);
  const passkeySigner = (v = verifier, kd = keyData, kind = "External") =>
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind), Address.fromString(v).toScVal(), xdr.ScVal.scvBytes(kd)]);

  function call(fn: string, args: xdr.ScVal[], o: { target?: string; signer?: string; nested?: boolean; entries?: number } = {}) {
    const invoke = new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(o.target ?? wallet).toScAddress(),
      functionName: fn,
      args,
    });
    const node = (children: xdr.SorobanAuthorizedInvocation[] = []) =>
      new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invoke),
        subInvocations: children,
      });
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(o.signer ?? wallet).toScAddress(),
          nonce: xdr.Int64.fromString("3"),
          signatureExpirationLedger: 100,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: node(o.nested ? [node()] : []),
    });
    return {
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(invoke),
      auth: Array.from({ length: o.entries ?? 1 }, () => entry),
    };
  }
  const check = (s: RelaySubmission) => validateWalletAdmin(s, { wallet, webauthnVerifier: verifier });
  const rule = (id = 0) => xdr.ScVal.scvU32(id);

  it("accepts adding a passkey and returns its key and credential", () => {
    const result = check(call("add_signer", [rule(), passkeySigner()]));
    expect(result.fn).toBe("add_signer");
    if (result.fn === "add_signer") {
      expect(result.publicKey.equals(publicKey)).toBe(true);
      expect(result.credentialId.toString()).toBe("backup-credential");
    }
  });

  it("accepts removing a signer by id", () => {
    expect(check(call("remove_signer", [rule(), xdr.ScVal.scvU32(4)]))).toEqual({ fn: "remove_signer", signerId: 4 });
  });

  it("refuses changing someone else's wallet or other functions", () => {
    expect(() => check(call("add_signer", [rule(), passkeySigner()], { target: contract("victim") }))).toThrow(/your own wallet/);
    expect(() => check(call("upgrade", [rule(), passkeySigner()]))).toThrow(/Only adding or removing/);
    expect(() => check(call("execute", [rule(), passkeySigner()]))).toThrow(/Only adding or removing/);
  });

  it("refuses signers that are not passkeys on the canonical verifier", () => {
    expect(() => check(call("add_signer", [rule(), passkeySigner(contract("attacker-verifier"))]))).toThrow(/canonical WebAuthn verifier/);
    expect(() => check(call("add_signer", [rule(), passkeySigner(verifier, keyData, "Delegated")]))).toThrow(/Only passkey signers/);
    const delegated = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Delegated"), Address.fromString(contract("x")).toScVal()]);
    expect(() => check(call("add_signer", [rule(), delegated]))).toThrow(/Only passkey signers/);
    expect(() => check(call("add_signer", [rule(), passkeySigner(verifier, publicKey)]))).toThrow(/not a WebAuthn public key/);
  });

  it("refuses rules other than the default one", () => {
    expect(() => check(call("add_signer", [rule(1), passkeySigner()]))).toThrow(/default rule/);
  });

  it("requires exactly one approval from the wallet for exactly this call", () => {
    expect(() => check(call("add_signer", [rule(), passkeySigner()], { signer: contract("other") }))).toThrow(/approved by your wallet/);
    expect(() => check(call("add_signer", [rule(), passkeySigner()], { nested: true }))).toThrow(/approved by your wallet/);
    expect(() => check(call("add_signer", [rule(), passkeySigner()], { entries: 2 }))).toThrow(/exactly one auth entry/);
  });
});

describe("forwarded write validation (user pays)", () => {
  const forwarder = contract("forwarder");
  const xlm = contract("xlm");
  const registry = contract("registry-fwd");
  const wallet = contract("wallet-fwd");
  const relayer = Keypair.random().publicKey();
  const docId = "3f1c2a9e-0000-4000-8000-0000000000aa";
  const cap = BigInt(5_000_000);
  const expected = { forwarder, xlm, registry, wallet, relayer, maxFeeCap: cap };
  const addr = (a: string) => Address.fromString(a).toScVal();
  const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
  const regArgs = (owner = wallet) => [addr(owner), xdr.ScVal.scvString(docId), xdr.ScVal.scvBytes(Buffer.alloc(32, 2))];

  type O = {
    forwarderAddr?: string; token?: string; max?: bigint; target?: string; fn?: string; args?: xdr.ScVal[];
    user?: string; relayerAddr?: string; rootMax?: bigint; spender?: string; callArgs?: xdr.ScVal[];
    extraSub?: boolean; dropApprove?: boolean; extraEntry?: string; withRelayerEntry?: boolean;
  };
  function build(o: O = {}): RelaySubmission {
    const max = o.max ?? BigInt(1_000_000);
    const exp = xdr.ScVal.scvU32(5000);
    const fn = o.fn ?? "register_document";
    const args = o.args ?? regArgs();
    const fwdArgs = [addr(o.token ?? xlm), i128(BigInt(1)), i128(max), exp, addr(o.target ?? registry), xdr.ScVal.scvSymbol(fn), xdr.ScVal.scvVec(args), addr(o.user ?? wallet), addr(o.relayerAddr ?? relayer)];
    const fwd = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(o.forwarderAddr ?? forwarder).toScAddress(), functionName: "forward", args: fwdArgs });
    const cfn = (c: string, name: string, a: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) =>
      new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({ contractAddress: Address.fromString(c).toScAddress(), functionName: name, args: a }),
        ),
        subInvocations: subs,
      });
    const subs = [
      ...(o.dropApprove ? [] : [cfn(xlm, "approve", [addr(wallet), addr(o.spender ?? forwarder), i128(max), exp])]),
      cfn(registry, fn, o.callArgs ?? args),
      ...(o.extraSub ? [cfn(xlm, "transfer", [addr(wallet), addr(relayer), i128(BigInt(1))])] : []),
    ];
    const root = cfn(forwarder, "forward", [addr(o.token ?? xlm), i128(o.rootMax ?? max), exp, addr(o.target ?? registry), xdr.ScVal.scvSymbol(fn), xdr.ScVal.scvVec(args)], subs);
    const entry = (who: string, inv: xdr.SorobanAuthorizedInvocation) =>
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({ address: Address.fromString(who).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 100, signature: xdr.ScVal.scvVoid() }),
        ),
        rootInvocation: inv,
      });
    const auth = [entry(wallet, root)];
    if (o.withRelayerEntry) auth.push(entry(relayer, cfn(forwarder, "forward", fwdArgs)));
    if (o.extraEntry) auth.push(entry(o.extraEntry, root));
    return { func: xdr.HostFunction.hostFunctionTypeInvokeContract(fwd), auth };
  }
  const check = (s: RelaySubmission) => validateForwardedWrite(s, expected);

  it("accepts a forwarded register and reports the note and fee cap", () => {
    expect(check(build())).toEqual({ fn: "register_document", docId, maxFee: BigInt(1_000_000), expirationLedger: 5000 });
    expect(check(build({ withRelayerEntry: true }))).toMatchObject({ docId });
  });

  it("refuses other forwarders, tokens, targets, payers and fee recipients", () => {
    expect(() => check(build({ forwarderAddr: contract("evil-forwarder") }))).toThrow(/fee forwarder/);
    expect(() => check(build({ token: contract("usdc") }))).toThrow(/paid in XLM/);
    expect(() => check(build({ target: contract("token") }))).toThrow(/Only the Doqtri registry/);
    expect(() => check(build({ user: contract("victim") }))).toThrow(/your own wallet/);
    expect(() => check(build({ relayerAddr: Keypair.random().publicKey() }))).toThrow(/Doqtri's relayer/);
  });

  it("caps what the user can be asked to pay", () => {
    expect(() => check(build({ max: cap + BigInt(1) }))).toThrow(/outside the allowed range/);
    expect(() => check(build({ max: BigInt(0) }))).toThrow(/outside the allowed range/);
  });

  it("forwards the *_as writes with the same rules", () => {
    const asArgs = (signer = wallet) => [addr(signer), xdr.ScVal.scvString(docId), xdr.ScVal.scvBytes(Buffer.alloc(32, 2))];
    expect(check(build({ fn: "update_document_as", args: asArgs() }))).toEqual({
      fn: "update_document_as",
      docId,
      maxFee: BigInt(1_000_000),
      expirationLedger: 5000,
    });
    expect(() => check(build({ fn: "update_document_as", args: asArgs(contract("someone-else")) }))).toThrow(/name your wallet/);
  });

  it("still applies the registry rules to the wrapped call", () => {
    expect(() => check(build({ args: regArgs(contract("someone-else")) }))).toThrow(/name your wallet/);
    expect(() => check(build({ fn: "transfer" }))).toThrow(/not allowed/);
  });

  it("requires the wallet's approval to cover exactly this call", () => {
    expect(() => check(build({ rootMax: BigInt(999) }))).toThrow(/exactly this forwarded call/);
    expect(() => check(build({ spender: contract("thief") }))).toThrow(/exactly this forwarded call/);
    expect(() => check(build({ callArgs: [addr(wallet), xdr.ScVal.scvString("other-doc"), xdr.ScVal.scvBytes(Buffer.alloc(32, 2))] }))).toThrow(/exactly this forwarded call/);
    expect(() => check(build({ extraSub: true }))).toThrow(/exactly this forwarded call/);
    expect(() => check(build({ dropApprove: true }))).toThrow(/exactly this forwarded call/);
    expect(() => check(build({ extraEntry: contract("stranger") }))).toThrow(/exactly one approval/);
  });
});
