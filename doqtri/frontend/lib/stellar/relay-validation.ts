/**
 * Server-side checks for what /api/chain/relay may submit (server-only).
 *
 * The relay spends Doqtri's Channels fee allowance, so it accepts only the
 * exact shapes Doqtri produces and refuses everything else. Ported from
 * smart-account-kit's reference relayer-proxy (v0.8.0, unaudited) and made
 * stricter: the signer must use the canonical WebAuthn verifier and the
 * wallet must carry the threshold-1 policy.
 *
 * These checks bound spending; they do not prove wallet ownership. Ownership
 * is the session (the route) plus the passkey signature (the contract).
 */
import { Address, hash, Keypair, nativeToScVal, scValToBigInt, StrKey, xdr } from "@stellar/stellar-sdk";
import { roleAtLeast, type WorkspaceRole } from "@/lib/workspace-roles";

export class RelayRejection extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = "RelayRejection";
  }
}

/** At most this many auth entries per submission (relayer-proxy's limit). */
const MAX_AUTH_ENTRIES = 8;

export type RelaySubmission = {
  func: xdr.HostFunction;
  auth: xdr.SorobanAuthorizationEntry[];
};

/** Accepts exactly `{ func, auth }` as the kit's RelayerClient sends it. */
export function parseRelayBody(body: unknown): RelaySubmission {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RelayRejection("Request body must be a JSON object", 400);
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "func" && key !== "auth")) {
    throw new RelayRejection("Only { func, auth } submissions are accepted", 400);
  }
  const { func, auth } = record;
  if (typeof func !== "string" || !func || !Array.isArray(auth) || auth.length === 0) {
    throw new RelayRejection("Request must include func and auth", 400);
  }
  if (auth.length > MAX_AUTH_ENTRIES || auth.some((entry) => typeof entry !== "string" || !entry)) {
    throw new RelayRejection("Invalid auth entries", 400);
  }
  try {
    return {
      func: xdr.HostFunction.fromXDR(func, "base64"),
      auth: (auth as string[]).map((entry) => xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64")),
    };
  } catch {
    throw new RelayRejection("func/auth contains invalid XDR", 400);
  }
}

export type WalletDeployExpectations = {
  accountWasmHash: string;
  webauthnVerifier: string;
  thresholdPolicy: string;
  deployer: string;
};

export type WalletDeploy = {
  /** Raw WebAuthn credential id (the bytes after the 65-byte key). */
  credentialId: Buffer;
  /** Uncompressed secp256r1 public key, 65 bytes, 0x04-prefixed. */
  publicKey: Buffer;
  deployer: string;
  salt: Buffer;
};

/** The shared deterministic deployer's public key for a seed. */
export function deployerAddress(seed: string): string {
  return Keypair.fromRawEd25519Seed(hash(Buffer.from(seed))).publicKey();
}

/**
 * A wallet deploy exactly as `kit.createWallet` builds it: one createContractV2
 * of the canonical account wasm from the shared deployer, constructed with one
 * External WebAuthn signer on the canonical verifier, the threshold-1 policy,
 * and a salt equal to sha256(credential id); one auth entry, signed by the
 * deployer, authorizing exactly that deploy.
 */
export function validateWalletDeploy(
  { func, auth }: RelaySubmission,
  expected: WalletDeployExpectations,
): WalletDeploy {
  if (func.switch().name !== "hostFunctionTypeCreateContractV2") {
    throw new RelayRejection("Only wallet deployments are accepted here");
  }
  const deploy = func.createContractV2();

  const executable = deploy.executable();
  if (
    executable.switch().name !== "contractExecutableWasm" ||
    executable.wasmHash().toString("hex") !== expected.accountWasmHash
  ) {
    throw new RelayRejection("Deploy must use the canonical smart-account wasm");
  }

  const preimage = deploy.contractIdPreimage();
  if (preimage.switch().name !== "contractIdPreimageFromAddress") {
    throw new RelayRejection("Deploy must use an address contract-id preimage");
  }
  const deployer = Address.fromScAddress(preimage.fromAddress().address()).toString();
  if (deployer !== expected.deployer) {
    throw new RelayRejection("Deploy must come from the shared deployer");
  }
  const salt = Buffer.from(preimage.fromAddress().salt());

  const args = deploy.constructorArgs();
  if (args.length !== 2 || args[0].switch().name !== "scvVec" || args[1].switch().name !== "scvMap") {
    throw new RelayRejection("Deploy constructor has an invalid argument shape");
  }

  const signers = args[0].vec() ?? [];
  const signer = signers.length === 1 && signers[0].switch().name === "scvVec" ? signers[0].vec() ?? [] : [];
  if (
    signer.length !== 3 ||
    signer[0].switch().name !== "scvSymbol" ||
    signer[0].sym().toString() !== "External" ||
    signer[1].switch().name !== "scvAddress" ||
    signer[2].switch().name !== "scvBytes"
  ) {
    throw new RelayRejection("Deploy must have exactly one External signer");
  }
  if (Address.fromScAddress(signer[1].address()).toString() !== expected.webauthnVerifier) {
    throw new RelayRejection("Signer must use the canonical WebAuthn verifier");
  }
  const keyData = Buffer.from(signer[2].bytes());
  if (keyData.length <= 65 || keyData[0] !== 0x04) {
    throw new RelayRejection("Signer key data is not a WebAuthn public key and credential id");
  }
  const publicKey = keyData.subarray(0, 65);
  const credentialId = keyData.subarray(65);
  if (!hash(credentialId).equals(salt)) {
    throw new RelayRejection("Deploy salt does not match the signer credential id");
  }

  const policies = args[1].map() ?? [];
  const policy = policies[0];
  const params = policy?.val().switch().name === "scvMap" ? policy.val().map() ?? [] : [];
  if (
    policies.length !== 1 ||
    policy.key().switch().name !== "scvAddress" ||
    Address.fromScAddress(policy.key().address()).toString() !== expected.thresholdPolicy ||
    params.length !== 1 ||
    params[0].key().switch().name !== "scvSymbol" ||
    params[0].key().sym().toString() !== "threshold" ||
    params[0].val().switch().name !== "scvU32" ||
    params[0].val().u32() !== 1
  ) {
    throw new RelayRejection("Wallet must install exactly the threshold-1 policy");
  }

  if (auth.length !== 1) {
    throw new RelayRejection("Deploy must carry exactly one auth entry");
  }
  const credentials = auth[0].credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") {
    throw new RelayRejection("Deploy auth must use address credentials");
  }
  const root = auth[0].rootInvocation();
  if (
    Address.fromScAddress(credentials.address().address()).toString() !== deployer ||
    root.subInvocations().length !== 0 ||
    root.function().switch().name !== "sorobanAuthorizedFunctionTypeCreateContractV2HostFn" ||
    !root.function().createContractV2HostFn().toXDR().equals(deploy.toXDR())
  ) {
    throw new RelayRejection("Deploy auth does not exactly match the deploy");
  }

  return { credentialId: Buffer.from(credentialId), publicKey: Buffer.from(publicKey), deployer, salt };
}

/** The C... address a deploy from `deployer` with `salt` creates on a network. */
export function deployedContractAddress(deployer: string, salt: Buffer, networkPassphrase: string): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/** The live (v2) registry's writes: only the document's owner signs them. */
export const OWNER_FUNCTIONS = ["register_document", "update_document", "set_node_status", "anchor"] as const;

/**
 * v3 document writes (WP-1.3): the `*_as` calls, which name their signer and
 * let any writer of a workspace document make them, and moving a document
 * into or out of its workspace.
 */
export const EDITOR_DOCUMENT_FUNCTIONS = [
  "anchor_as",
  "update_document_as",
  "set_node_status_as",
  "assign_document",
  "unassign_document",
] as const;

/**
 * v3 membership writes, signed by the workspace's owner or an admin.
 * `transfer_workspace` is not relayed: both owners must sign it, and a relay
 * submission carries one wallet's approval. The calls only the contract admin
 * or the revoker makes (upgrade, import_*, set_revoker, admin_reassign_owner,
 * revocations) are signed by server keys and never pass through here. The
 * server builds both ownership calls with buildOwnershipTransfer()
 * (ownership-transfer.ts), which refuses a personal workspace (D-37).
 */
export const WORKSPACE_FUNCTIONS = ["create_workspace", "add_editor", "remove_editor", "add_admin", "remove_admin"] as const;

export const REGISTRY_FUNCTIONS = [...OWNER_FUNCTIONS, ...EDITOR_DOCUMENT_FUNCTIONS, ...WORKSPACE_FUNCTIONS] as const;

export type OwnerFunction = (typeof OWNER_FUNCTIONS)[number];
export type EditorDocumentFunction = (typeof EDITOR_DOCUMENT_FUNCTIONS)[number];
export type WorkspaceFunction = (typeof WORKSPACE_FUNCTIONS)[number];
export type RegistryFunction = (typeof REGISTRY_FUNCTIONS)[number];

/**
 * Functions only the v3 registry has. Until the deployed registry is
 * upgraded (REGISTRY_EDITORS) the relay refuses them rather than paying to
 * simulate a call the contract does not have.
 */
export const V3_FUNCTIONS: readonly RegistryFunction[] = [...EDITOR_DOCUMENT_FUNCTIONS, ...WORKSPACE_FUNCTIONS];

/** The same cap as the registry's MAX_NODES_PER_CALL. */
export const MAX_ANCHOR_NODES = 32;

/** NodeUpdate's fields, as a struct arrives: an ScMap sorted by field name. */
const NODE_UPDATE_FIELDS = ["artifact_ref", "node_id", "status", "tool"];

function isNodeUpdate(value: xdr.ScVal): boolean {
  if (value.switch().name !== "scvMap") return false;
  const entries = value.map() ?? [];
  if (entries.length !== NODE_UPDATE_FIELDS.length) return false;
  return entries.every((entry, i) => {
    const key = entry.key();
    if (key.switch().name !== "scvSymbol" || key.sym().toString() !== NODE_UPDATE_FIELDS[i]) return false;
    const field = entry.val();
    return NODE_UPDATE_FIELDS[i] === "status" ? field.switch().name === "scvVec" : isString(field);
  });
}

/** A write on one document; `workspaceId` is set for `assign_document`. */
export type DocumentWrite = { fn: OwnerFunction | EditorDocumentFunction; docId: string; workspaceId?: string };

/** A membership write; `subject` is the member added or removed (null for create_workspace). */
export type WorkspaceWrite = { fn: WorkspaceFunction; workspaceId: string; subject: string | null };

export type RegistryWrite = DocumentWrite | WorkspaceWrite;

export function isDocumentWrite(write: RegistryWrite): write is DocumentWrite {
  return "docId" in write;
}

/** The address an auth entry signs for, for V1 and V2 address credentials. */
function credentialAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const credentials = entry.credentials();
  switch (credentials.switch().name) {
    case "sorobanCredentialsAddress":
      return Address.fromScAddress(credentials.address().address()).toString();
    case "sorobanCredentialsAddressV2":
      return Address.fromScAddress(credentials.addressV2().address()).toString();
    default:
      return null;
  }
}

function isString(value: xdr.ScVal | undefined): value is xdr.ScVal {
  return value?.switch().name === "scvString";
}

function isHash(value: xdr.ScVal | undefined): boolean {
  return value?.switch().name === "scvBytes" && value.bytes().length === 32;
}

/**
 * On-chain workspace ids are the app's workspace ids (workspaces.id), so the
 * relay only ever pays for calls on a workspace the database knows.
 */
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function workspaceIdOf(value: xdr.ScVal | undefined): string | null {
  if (!isString(value)) return null;
  const id = value.str().toString();
  return WORKSPACE_ID.test(id) ? id : null;
}

/**
 * A DoqtriRegistry write signed by the caller's own smart wallet: one
 * invocation of one registry function on exactly `registry`, with the
 * argument shapes the contract declares, and one auth entry from `wallet`
 * authorizing exactly that invocation and nothing nested.
 *
 * The caller still has to authorize it against the database
 * (authorizeRegistryWrite): that the note or workspace is one the user may
 * write.
 */
export function validateRegistryWrite(
  { func, auth }: RelaySubmission,
  expected: { registry: string; wallet: string },
): RegistryWrite {
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new RelayRejection("Only registry calls are accepted here");
  }
  const invoke = func.invokeContract();
  if (Address.fromScAddress(invoke.contractAddress()).toString() !== expected.registry) {
    throw new RelayRejection("Only the Doqtri registry can be called");
  }
  const write = validateRegistryCall(invoke.functionName().toString(), invoke.args(), expected.wallet);

  if (auth.length !== 1) {
    throw new RelayRejection("A registry write must carry exactly one auth entry");
  }
  const root = auth[0].rootInvocation();
  if (
    credentialAddress(auth[0]) !== expected.wallet ||
    root.subInvocations().length !== 0 ||
    root.function().switch().name !== "sorobanAuthorizedFunctionTypeContractFn" ||
    !root.function().contractFn().toXDR().equals(invoke.toXDR())
  ) {
    throw new RelayRejection("The signature must come from your wallet for exactly this call");
  }

  return write;
}

/**
 * One of the registry's write functions with the argument shapes the contract
 * declares. Every argument that names who acts (`owner`, `signer`, `admin`,
 * `caller`) must be `wallet`; `anchor` and `anchor_as` take at most
 * MAX_ANCHOR_NODES well-formed node updates; workspace ids must be app
 * workspace ids. `assign_document` and `unassign_document` name nobody: the
 * single auth entry from `wallet` is their signer. Shared by direct and
 * forwarded writes.
 */
export function validateRegistryCall(fnName: string, args: xdr.ScVal[], wallet: string): RegistryWrite {
  const fn = fnName as RegistryFunction;
  if (!REGISTRY_FUNCTIONS.includes(fn)) {
    throw new RelayRejection("That registry function is not allowed");
  }
  const isWallet = (value: xdr.ScVal | undefined) => addressOf(value) === wallet;
  const bad = () => new RelayRejection(`${fn} has an invalid argument shape`);

  switch (fn) {
    case "register_document":
      if (args.length !== 3 || !isWallet(args[0]) || !isString(args[1]) || !isHash(args[2])) {
        throw new RelayRejection("register_document must name your wallet as the owner");
      }
      return { fn, docId: args[1].str().toString() };
    case "anchor":
    case "anchor_as": {
      const nodes = args[3]?.switch().name === "scvVec" ? (args[3].vec() ?? []) : null;
      if (
        args.length !== 4 ||
        !isWallet(args[0]) ||
        !isString(args[1]) ||
        !isHash(args[2]) ||
        nodes === null ||
        nodes.length > MAX_ANCHOR_NODES ||
        !nodes.every(isNodeUpdate)
      ) {
        const who = fn === "anchor" ? "owner" : "signer";
        throw new RelayRejection(`${fn} must name your wallet as the ${who}, with at most 32 node updates`);
      }
      return { fn, docId: args[1].str().toString() };
    }
    case "update_document":
      if (args.length !== 2 || !isString(args[0]) || !isHash(args[1])) throw bad();
      return { fn, docId: args[0].str().toString() };
    case "update_document_as":
      if (args.length !== 3 || !isString(args[1]) || !isHash(args[2])) throw bad();
      if (!isWallet(args[0])) throw new RelayRejection("update_document_as must name your wallet as the signer");
      return { fn, docId: args[1].str().toString() };
    case "set_node_status":
      if (
        args.length !== 5 ||
        !isString(args[0]) ||
        !isString(args[1]) ||
        args[2].switch().name !== "scvVec" ||
        !isString(args[3]) ||
        !isString(args[4])
      ) {
        throw bad();
      }
      return { fn, docId: args[0].str().toString() };
    case "set_node_status_as":
      if (
        args.length !== 6 ||
        !isString(args[1]) ||
        !isString(args[2]) ||
        args[3].switch().name !== "scvVec" ||
        !isString(args[4]) ||
        !isString(args[5])
      ) {
        throw bad();
      }
      if (!isWallet(args[0])) throw new RelayRejection("set_node_status_as must name your wallet as the signer");
      return { fn, docId: args[1].str().toString() };
    case "assign_document": {
      const workspaceId = workspaceIdOf(args[1]);
      if (args.length !== 2 || !isString(args[0]) || !workspaceId) throw bad();
      return { fn, docId: args[0].str().toString(), workspaceId };
    }
    case "unassign_document":
      if (args.length !== 1 || !isString(args[0])) throw bad();
      return { fn, docId: args[0].str().toString() };
    case "create_workspace": {
      const workspaceId = workspaceIdOf(args[0]);
      if (args.length !== 2 || !workspaceId) throw bad();
      if (!isWallet(args[1])) throw new RelayRejection("create_workspace must name your wallet as the owner");
      return { fn, workspaceId, subject: null };
    }
    case "add_editor":
    case "remove_editor":
    case "add_admin":
    case "remove_admin": {
      const workspaceId = workspaceIdOf(args[0]);
      const subject = addressOf(args[2]);
      if (args.length !== 3 || !workspaceId || addressOf(args[1]) === null || subject === null) throw bad();
      if (!isWallet(args[1])) {
        const who = fn === "add_admin" ? "owner" : fn === "add_editor" ? "admin" : "caller";
        throw new RelayRejection(`${fn} must name your wallet as the ${who}`);
      }
      return { fn, workspaceId, subject };
    }
  }
}

/** Where a note sits in doqtri's database, for the relay's checks. */
export type NoteWorkspace = {
  workspaceId: string;
  /** A personal workspace: only its creator owns it (D-30), and its notes stay off the `*_as` calls. */
  personal: boolean;
  /** The note's creator (documents.user_id); null once their account is deleted. */
  creatorId: string | null;
};

/**
 * What authorizeRegistryWrite reads from doqtri's database. The relay route
 * backs it with the service role (registry-access.ts); tests with fixtures.
 */
export type RegistryAccess = {
  /** The workspace a note belongs to, or null when there is no such note. */
  documentWorkspace(docId: string): Promise<NoteWorkspace | null>;
  /** Whether a workspace is personal (D-30), or null when there is no such workspace. */
  workspace(workspaceId: string): Promise<{ personal: boolean } | null>;
  /** The user's current role in a workspace, or null when they are not (or no longer) a member. */
  memberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  /** The role of the account holding `address` (a passkey or Freighter wallet), or null. */
  addressRole(workspaceId: string, address: string): Promise<WorkspaceRole | null>;
};

/** Below these, a member may not sign the call (D-10, D-14, D-23). */
const MIN_ROLE: Record<RegistryFunction, WorkspaceRole> = {
  register_document: "editor",
  update_document: "editor",
  set_node_status: "editor",
  anchor: "editor",
  anchor_as: "editor",
  update_document_as: "editor",
  set_node_status_as: "editor",
  assign_document: "editor",
  // The contract makes the workspace's owner sign it.
  unassign_document: "owner",
  create_workspace: "owner",
  add_editor: "admin",
  remove_editor: "admin",
  add_admin: "owner",
  remove_admin: "owner",
};

const NOT_IN_VAULT = "That note isn't in your vault.";

function isOwnerFunction(fn: RegistryFunction): fn is OwnerFunction {
  return (OWNER_FUNCTIONS as readonly string[]).includes(fn);
}

/**
 * The relay pays only for writes the user may make right now, as doqtri's
 * database has it: the contract checks signatures and its own member list,
 * this checks the workspace roles. Membership is read at the moment of the
 * request, so a member removed in the app is refused from the next request
 * on (D-16), whatever the chain still says.
 *
 * `editors` is REGISTRY_EDITORS: whether the deployed registry has the v3
 * calls. Without it they are refused outright, rather than paying to
 * simulate a call the contract does not have.
 *
 * - A note write needs an editor or above of the note's workspace (viewers
 *   read, D-14); taking a note out of its workspace needs an owner, and a
 *   note can only be assigned to the workspace it belongs to.
 * - A personal workspace's note is written by that workspace's owner only,
 *   whatever role its other members hold (D-30): its writes stay on the
 *   owner-only calls and it is never assigned, so whichever wallet anchored
 *   it first would own it on-chain for good.
 * - A team note's owner-only writes (`register_document`, `anchor`, …) would
 *   leave the note owned on-chain by whoever signed first. With `editors`
 *   on they are refused: team notes go through `anchor_as` and then
 *   `assign_document` (D-28). With it off they are the only calls there are,
 *   and only the note's creator or the workspace's owner may make them, as
 *   before workspaces had editors.
 * - Creating the on-chain workspace needs an owner; adding or removing an
 *   editor an admin or above; adding or removing an admin an owner. In a
 *   personal workspace every one of them needs its owner, since only the
 *   owner signs there (D-44). Only an
 *   editor (or above) may be given chain write access, and only an admin
 *   (or above) made an on-chain admin, so the chain never holds a role the
 *   database does not.
 *
 * The panel hides what this would refuse with noteSigningRefusal()
 * (note-signing.ts), whose tests hold it to these rules.
 *
 * Throws RelayRejection when refused.
 */
export async function authorizeRegistryWrite(
  write: RegistryWrite,
  userId: string,
  access: RegistryAccess,
  editors: boolean,
): Promise<void> {
  if (!editors && V3_FUNCTIONS.includes(write.fn)) {
    throw new RelayRejection("Workspace calls aren't enabled on this registry yet.");
  }
  const min = MIN_ROLE[write.fn];
  if (isDocumentWrite(write)) {
    const note = await access.documentWorkspace(write.docId);
    // An outsider and a removed member get the same answer as a missing note.
    const role = note ? await access.memberRole(note.workspaceId, userId) : null;
    if (!note || !role) throw new RelayRejection(NOT_IN_VAULT);
    if (!roleAtLeast(role, min)) {
      throw new RelayRejection(
        min === "owner"
          ? "Only an owner of this note's workspace can do that."
          : "Viewers can read this note but not sign changes to it.",
      );
    }
    if (note.personal) {
      if (role !== "owner") {
        throw new RelayRejection("Only the owner of a personal workspace can sign changes to its notes.");
      }
      if (write.fn === "assign_document") {
        throw new RelayRejection("A personal workspace's notes aren't put in a workspace on-chain.");
      }
    } else if (isOwnerFunction(write.fn)) {
      if (editors) {
        throw new RelayRejection("Team notes are written through the workspace calls. Reload and try again.");
      }
      if (note.creatorId !== userId && role !== "owner") {
        throw new RelayRejection("Only this note's author or its workspace owner can anchor it for now.");
      }
    }
    if (write.fn === "assign_document" && write.workspaceId !== note.workspaceId) {
      throw new RelayRejection("A note can only be assigned to the workspace it belongs to.");
    }
    return;
  }

  const role = await access.memberRole(write.workspaceId, userId);
  if (!role) throw new RelayRejection("You aren't a member of that workspace.");
  if (!roleAtLeast(role, min)) {
    throw new RelayRejection(min === "owner" ? "Only a workspace owner can do that." : "Only a workspace admin can do that.");
  }
  const workspace = await access.workspace(write.workspaceId);
  if (!workspace) throw new RelayRejection("You aren't a member of that workspace.");
  if (workspace.personal && role !== "owner") {
    throw new RelayRejection("Only the owner of a personal workspace can sign changes to it.");
  }
  if (write.fn === "add_editor" || write.fn === "add_admin") {
    const needed: WorkspaceRole = write.fn === "add_admin" ? "admin" : "editor";
    const subjectRole = write.subject ? await access.addressRole(write.workspaceId, write.subject) : null;
    if (!roleAtLeast(subjectRole, needed)) {
      throw new RelayRejection(
        write.fn === "add_admin"
          ? "Only a workspace admin can be made an admin on-chain."
          : "Only a workspace editor can be given write access on-chain.",
      );
    }
  }
}

export type WalletAdminCall =
  | { fn: "add_signer"; credentialId: Buffer; publicKey: Buffer }
  | { fn: "remove_signer"; signerId: number };

/**
 * A passkey change on the caller's own wallet, as `kit.signers.addPasskey`
 * and `kit.signers.remove` build it: `add_signer` or `remove_signer` on the
 * wallet itself, on its default rule (0), adding only an External signer on
 * the canonical WebAuthn verifier, with one auth entry from the wallet for
 * exactly that call.
 *
 * The wallet contract is what requires an existing signer to approve the
 * change; this only keeps the relay from paying for anything else. The caller
 * still has to refuse removing the last passkey.
 */
export function validateWalletAdmin(
  { func, auth }: RelaySubmission,
  expected: { wallet: string; webauthnVerifier: string },
): WalletAdminCall {
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new RelayRejection("Only wallet calls are accepted here");
  }
  const invoke = func.invokeContract();
  if (Address.fromScAddress(invoke.contractAddress()).toString() !== expected.wallet) {
    throw new RelayRejection("Only your own wallet can be changed");
  }
  const fn = invoke.functionName().toString();
  const args = invoke.args();
  if (args.length !== 2 || args[0].switch().name !== "scvU32" || args[0].u32() !== 0) {
    throw new RelayRejection("Passkey changes must target the wallet's default rule");
  }

  let call: WalletAdminCall;
  if (fn === "add_signer") {
    const signer = args[1].switch().name === "scvVec" ? args[1].vec() ?? [] : [];
    if (
      signer.length !== 3 ||
      signer[0].switch().name !== "scvSymbol" ||
      signer[0].sym().toString() !== "External" ||
      signer[1].switch().name !== "scvAddress" ||
      signer[2].switch().name !== "scvBytes"
    ) {
      throw new RelayRejection("Only passkey signers can be added");
    }
    if (Address.fromScAddress(signer[1].address()).toString() !== expected.webauthnVerifier) {
      throw new RelayRejection("New passkeys must use the canonical WebAuthn verifier");
    }
    const keyData = Buffer.from(signer[2].bytes());
    if (keyData.length <= 65 || keyData[0] !== 0x04) {
      throw new RelayRejection("Signer key data is not a WebAuthn public key and credential id");
    }
    call = { fn, publicKey: keyData.subarray(0, 65), credentialId: keyData.subarray(65) };
  } else if (fn === "remove_signer") {
    if (args[1].switch().name !== "scvU32") {
      throw new RelayRejection("remove_signer has an invalid argument shape");
    }
    call = { fn, signerId: args[1].u32() };
  } else {
    throw new RelayRejection("Only adding or removing a passkey is allowed");
  }

  if (auth.length !== 1) {
    throw new RelayRejection("A wallet change must carry exactly one auth entry");
  }
  const root = auth[0].rootInvocation();
  if (
    credentialAddress(auth[0]) !== expected.wallet ||
    root.subInvocations().length !== 0 ||
    root.function().switch().name !== "sorobanAuthorizedFunctionTypeContractFn" ||
    !root.function().contractFn().toXDR().equals(invoke.toXDR())
  ) {
    throw new RelayRejection("The change must be approved by your wallet for exactly this call");
  }
  return call;
}

export type ForwardedWrite = RegistryWrite & { maxFee: bigint; expirationLedger: number };

function addressOf(value: xdr.ScVal | undefined): string | null {
  return value?.switch().name === "scvAddress" ? Address.fromScAddress(value.address()).toString() : null;
}

function sameScVals(a: xdr.ScVal[], b: xdr.ScVal[]): boolean {
  return a.length === b.length && a.every((v, i) => v.toXDR().equals(b[i].toXDR()));
}

/**
 * A registry write wrapped in Doqtri's FeeForwarder, so the user's wallet pays
 * the fee (progress/003):
 *
 *   forward(fee_token, fee_amount, max_fee_amount, expiration_ledger,
 *           registry, fn, args, user = wallet, relayer = Doqtri)
 *
 * The wallet's single auth entry must be that `forward` call (over everything
 * except the fee amount and relayer, as the forwarder requires) with exactly
 * two sub-invocations: approving the forwarder to spend at most the max fee
 * in XLM, and the registry call itself. Any relayer auth entry the browser
 * sends is dropped; the server signs its own for the fee it sets.
 */
export function validateForwardedWrite(
  { func, auth }: RelaySubmission,
  expected: { forwarder: string; xlm: string; registry: string; wallet: string; relayer: string; maxFeeCap: bigint },
): ForwardedWrite {
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new RelayRejection("Only forwarded registry calls are accepted here");
  }
  const invoke = func.invokeContract();
  if (
    Address.fromScAddress(invoke.contractAddress()).toString() !== expected.forwarder ||
    invoke.functionName().toString() !== "forward"
  ) {
    throw new RelayRejection("Only Doqtri's fee forwarder can be called");
  }
  const a = invoke.args();
  if (a.length !== 9) throw new RelayRejection("forward has an invalid argument shape");
  const [feeToken, feeAmount, maxFee, expiration, target, targetFn, targetArgs, user, relayer] = a;

  if (addressOf(feeToken) !== expected.xlm) throw new RelayRejection("Fees must be paid in XLM");
  if (feeAmount.switch().name !== "scvI128" || maxFee.switch().name !== "scvI128") {
    throw new RelayRejection("Fee amounts have an invalid shape");
  }
  const max = scValToBigInt(maxFee);
  if (max <= BigInt(0) || max > expected.maxFeeCap) {
    throw new RelayRejection("The maximum fee is outside the allowed range");
  }
  if (expiration.switch().name !== "scvU32") throw new RelayRejection("The fee approval has no valid expiry");
  if (addressOf(target) !== expected.registry) throw new RelayRejection("Only the Doqtri registry can be called");
  if (targetFn.switch().name !== "scvSymbol" || targetArgs.switch().name !== "scvVec") {
    throw new RelayRejection("The forwarded call has an invalid shape");
  }
  const inner = targetArgs.vec() ?? [];
  const write = validateRegistryCall(targetFn.sym().toString(), inner, expected.wallet);
  if (addressOf(user) !== expected.wallet) throw new RelayRejection("Only your own wallet can pay for this");
  if (addressOf(relayer) !== expected.relayer) throw new RelayRejection("The fee must go to Doqtri's relayer");

  const walletEntries = auth.filter((entry) => credentialAddress(entry) === expected.wallet);
  if (walletEntries.length !== 1 || auth.some((e) => ![expected.wallet, expected.relayer].includes(credentialAddress(e) ?? ""))) {
    throw new RelayRejection("A forwarded write must carry exactly one approval from your wallet");
  }
  const root = walletEntries[0].rootInvocation();
  const rootFn = root.function();
  const subs = root.subInvocations();
  const fnOf = (inv: xdr.SorobanAuthorizedInvocation) =>
    inv.function().switch().name === "sorobanAuthorizedFunctionTypeContractFn" ? inv.function().contractFn() : null;
  const approve = subs.map(fnOf).find((f) => f && Address.fromScAddress(f.contractAddress()).toString() === expected.xlm);
  const call = subs.map(fnOf).find((f) => f && Address.fromScAddress(f.contractAddress()).toString() === expected.registry);
  const walletAddr = Address.fromString(expected.wallet).toScVal();
  const forwarderAddr = Address.fromString(expected.forwarder).toScVal();
  if (
    rootFn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn" ||
    Address.fromScAddress(rootFn.contractFn().contractAddress()).toString() !== expected.forwarder ||
    rootFn.contractFn().functionName().toString() !== "forward" ||
    !sameScVals(rootFn.contractFn().args(), [feeToken, maxFee, expiration, target, targetFn, targetArgs]) ||
    subs.length !== 2 ||
    subs.some((s) => s.subInvocations().length !== 0) ||
    !approve ||
    approve.functionName().toString() !== "approve" ||
    !sameScVals(approve.args(), [walletAddr, forwarderAddr, maxFee, expiration]) ||
    !call ||
    call.functionName().toString() !== targetFn.sym().toString() ||
    !sameScVals(call.args(), inner)
  ) {
    throw new RelayRejection("Your wallet's approval must cover exactly this forwarded call");
  }

  return { ...write, maxFee: max, expirationLedger: expiration.u32() };
}

// ---------------------------------------------------------------------------
// Template marketplace (progress/004). Market calls move tokens, so on top of
// the registry rules every token transfer the wallet approves must be one the
// contract will make, to the recipients and amounts the caller computed from
// the ledger. The relay must never pay to submit a transfer anywhere else.

export const MARKET_FUNCTIONS = ["list_template", "update_price", "set_listed", "buy", "tip"] as const;
export type MarketFunction = (typeof MARKET_FUNCTIONS)[number];

export type MarketCall =
  | { fn: "list_template"; templateId: string; contentHash: string; token: string; price: bigint; parent: string | null }
  | { fn: "update_price"; templateId: string; price: bigint }
  | { fn: "set_listed"; templateId: string; listed: boolean }
  | { fn: "buy"; templateId: string; maxPrice: bigint }
  | { fn: "tip"; templateId: string; amount: bigint };

/** A `token.transfer(wallet, to, amount)` the wallet is expected to approve. */
export type ExpectedTransfer = { token: string; to: string; amount: bigint };

const TEMPLATE_ID = /^[a-z2-7]{16}$/;

function templateIdOf(value: xdr.ScVal | undefined): string | null {
  if (!isString(value)) return null;
  const id = value.str().toString();
  return TEMPLATE_ID.test(id) ? id : null;
}

function i128Of(value: xdr.ScVal | undefined): bigint | null {
  return value?.switch().name === "scvI128" ? scValToBigInt(value) : null;
}

/**
 * One of the market's write functions with the argument shapes the contract
 * declares, naming `wallet` wherever the call names who acts. `update_price`
 * and `set_listed` name nobody: the caller must check the template is the
 * user's own.
 */
export function validateMarketCall(fnName: string, args: xdr.ScVal[], wallet: string): MarketCall {
  const fn = fnName as MarketFunction;
  if (!MARKET_FUNCTIONS.includes(fn)) {
    throw new RelayRejection("That market function is not allowed");
  }
  const bad = () => new RelayRejection(`${fn} has an invalid argument shape`);
  switch (fn) {
    case "list_template": {
      const templateId = templateIdOf(args[1]);
      const token = addressOf(args[3]);
      const price = i128Of(args[4]);
      const parentVal = args[5];
      const parent = parentVal?.switch().name === "scvVoid" ? null : templateIdOf(parentVal);
      if (args.length !== 6 || !templateId || !isHash(args[2]) || !token || price === null || price < BigInt(0)) {
        throw bad();
      }
      if (parent === null && parentVal?.switch().name !== "scvVoid") throw bad();
      if (addressOf(args[0]) !== wallet) throw new RelayRejection("list_template must name your wallet as the creator");
      return { fn, templateId, contentHash: Buffer.from(args[2].bytes()).toString("hex"), token, price, parent };
    }
    case "update_price": {
      const templateId = templateIdOf(args[0]);
      const price = i128Of(args[1]);
      if (args.length !== 2 || !templateId || price === null || price < BigInt(0)) throw bad();
      return { fn, templateId, price };
    }
    case "set_listed": {
      const templateId = templateIdOf(args[0]);
      if (args.length !== 2 || !templateId || args[1].switch().name !== "scvBool") throw bad();
      return { fn, templateId, listed: args[1].b() };
    }
    case "buy": {
      const templateId = templateIdOf(args[1]);
      const maxPrice = i128Of(args[2]);
      if (args.length !== 3 || !templateId || maxPrice === null || maxPrice < BigInt(0)) throw bad();
      if (addressOf(args[0]) !== wallet) throw new RelayRejection("buy must name your wallet as the buyer");
      return { fn, templateId, maxPrice };
    }
    case "tip": {
      const templateId = templateIdOf(args[1]);
      const amount = i128Of(args[2]);
      if (args.length !== 3 || !templateId || amount === null || amount <= BigInt(0)) throw bad();
      if (addressOf(args[0]) !== wallet) throw new RelayRejection("tip must come from your wallet");
      return { fn, templateId, amount };
    }
  }
}

/** The market call inside an invoke, before any auth checks (to look up what it should transfer). */
export function marketCallOf(func: xdr.HostFunction, market: string, wallet: string): MarketCall {
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new RelayRejection("Only market calls are accepted here");
  }
  const invoke = func.invokeContract();
  if (Address.fromScAddress(invoke.contractAddress()).toString() !== market) {
    throw new RelayRejection("Only the Doqtri market can be called");
  }
  return validateMarketCall(invoke.functionName().toString(), invoke.args(), wallet);
}

/** The contract a `forward` call targets (its fifth argument), or null. */
export function forwardedTarget(func: xdr.HostFunction): string | null {
  if (func.switch().name !== "hostFunctionTypeInvokeContract") return null;
  return addressOf(func.invokeContract().args()[4]);
}

/** The market call wrapped in a `forward`, before any auth checks. */
export function forwardedMarketCallOf(func: xdr.HostFunction, market: string, wallet: string): MarketCall {
  const args = func.switch().name === "hostFunctionTypeInvokeContract" ? func.invokeContract().args() : [];
  const [, , , , target, targetFn, targetArgs] = args;
  if (args.length !== 9 || addressOf(target) !== market) {
    throw new RelayRejection("Only the Doqtri market can be called");
  }
  if (targetFn?.switch().name !== "scvSymbol" || targetArgs?.switch().name !== "scvVec") {
    throw new RelayRejection("The forwarded call has an invalid shape");
  }
  return validateMarketCall(targetFn.sym().toString(), targetArgs.vec() ?? [], wallet);
}

/** Exactly `transfers`, in order, each `transfer(wallet, to, amount)` with nothing nested. */
function isExactlyTransfers(
  subs: xdr.SorobanAuthorizedInvocation[],
  wallet: string,
  transfers: ExpectedTransfer[],
): boolean {
  const walletAddr = Address.fromString(wallet).toScVal();
  return (
    subs.length === transfers.length &&
    subs.every((sub, i) => {
      const fn = sub.function();
      if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn" || sub.subInvocations().length !== 0) {
        return false;
      }
      const call = fn.contractFn();
      const t = transfers[i];
      return (
        Address.fromScAddress(call.contractAddress()).toString() === t.token &&
        call.functionName().toString() === "transfer" &&
        sameScVals(call.args(), [walletAddr, Address.fromString(t.to).toScVal(), nativeToScVal(t.amount, { type: "i128" })])
      );
    })
  );
}

/**
 * A market write signed by the caller's wallet and sponsored by the relay
 * (networks without a FeeForwarder): one invocation on exactly `market`, and
 * one auth entry from `wallet` for exactly that call, whose only nested
 * approvals are `transfers`.
 */
export function validateMarketWrite(
  { func, auth }: RelaySubmission,
  expected: { market: string; wallet: string; transfers: ExpectedTransfer[] },
): MarketCall {
  const call = marketCallOf(func, expected.market, expected.wallet);
  const invoke = func.invokeContract();
  if (auth.length !== 1) {
    throw new RelayRejection("A market write must carry exactly one auth entry");
  }
  const root = auth[0].rootInvocation();
  if (
    credentialAddress(auth[0]) !== expected.wallet ||
    root.function().switch().name !== "sorobanAuthorizedFunctionTypeContractFn" ||
    !root.function().contractFn().toXDR().equals(invoke.toXDR()) ||
    !isExactlyTransfers(root.subInvocations(), expected.wallet, expected.transfers)
  ) {
    throw new RelayRejection("The signature must come from your wallet for exactly this call");
  }
  return call;
}

export type ForwardedMarketWrite = { call: MarketCall; maxFee: bigint; expirationLedger: number };

/**
 * A market write wrapped in Doqtri's FeeForwarder, so the wallet pays the
 * fee: the same `forward` shape as a forwarded registry write, except the
 * market call's own approval may nest the token transfers `buy` and `tip`
 * make — exactly `transfers`, and nothing else.
 */
export function validateForwardedMarketWrite(
  { func, auth }: RelaySubmission,
  expected: {
    forwarder: string;
    xlm: string;
    market: string;
    wallet: string;
    relayer: string;
    maxFeeCap: bigint;
    transfers: ExpectedTransfer[];
  },
): ForwardedMarketWrite {
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new RelayRejection("Only forwarded market calls are accepted here");
  }
  const invoke = func.invokeContract();
  if (
    Address.fromScAddress(invoke.contractAddress()).toString() !== expected.forwarder ||
    invoke.functionName().toString() !== "forward"
  ) {
    throw new RelayRejection("Only Doqtri's fee forwarder can be called");
  }
  const a = invoke.args();
  if (a.length !== 9) throw new RelayRejection("forward has an invalid argument shape");
  const [feeToken, feeAmount, maxFee, expiration, target, targetFn, , user, relayer] = a;

  if (addressOf(feeToken) !== expected.xlm) throw new RelayRejection("Fees must be paid in XLM");
  if (feeAmount.switch().name !== "scvI128" || maxFee.switch().name !== "scvI128") {
    throw new RelayRejection("Fee amounts have an invalid shape");
  }
  const max = scValToBigInt(maxFee);
  if (max <= BigInt(0) || max > expected.maxFeeCap) {
    throw new RelayRejection("The maximum fee is outside the allowed range");
  }
  if (expiration.switch().name !== "scvU32") throw new RelayRejection("The fee approval has no valid expiry");
  const call = forwardedMarketCallOf(func, expected.market, expected.wallet);
  const inner = a[6].vec() ?? [];
  if (addressOf(user) !== expected.wallet) throw new RelayRejection("Only your own wallet can pay for this");
  if (addressOf(relayer) !== expected.relayer) throw new RelayRejection("The fee must go to Doqtri's relayer");

  const walletEntries = auth.filter((entry) => credentialAddress(entry) === expected.wallet);
  if (walletEntries.length !== 1 || auth.some((e) => ![expected.wallet, expected.relayer].includes(credentialAddress(e) ?? ""))) {
    throw new RelayRejection("A forwarded write must carry exactly one approval from your wallet");
  }
  const root = walletEntries[0].rootInvocation();
  const rootFn = root.function();
  const subs = root.subInvocations();
  const contractOf = (inv: xdr.SorobanAuthorizedInvocation) =>
    inv.function().switch().name === "sorobanAuthorizedFunctionTypeContractFn"
      ? Address.fromScAddress(inv.function().contractFn().contractAddress()).toString()
      : null;
  const approve = subs.find((s) => contractOf(s) === expected.xlm);
  const marketCall = subs.find((s) => contractOf(s) === expected.market);
  const walletAddr = Address.fromString(expected.wallet).toScVal();
  const forwarderAddr = Address.fromString(expected.forwarder).toScVal();
  if (
    rootFn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn" ||
    Address.fromScAddress(rootFn.contractFn().contractAddress()).toString() !== expected.forwarder ||
    rootFn.contractFn().functionName().toString() !== "forward" ||
    !sameScVals(rootFn.contractFn().args(), [feeToken, maxFee, expiration, target, targetFn, a[6]]) ||
    subs.length !== 2 ||
    !approve ||
    approve.subInvocations().length !== 0 ||
    approve.function().contractFn().functionName().toString() !== "approve" ||
    !sameScVals(approve.function().contractFn().args(), [walletAddr, forwarderAddr, maxFee, expiration]) ||
    !marketCall ||
    marketCall.function().contractFn().functionName().toString() !== targetFn.sym().toString() ||
    !sameScVals(marketCall.function().contractFn().args(), inner) ||
    !isExactlyTransfers(marketCall.subInvocations(), expected.wallet, expected.transfers)
  ) {
    throw new RelayRejection("Your wallet's approval must cover exactly this forwarded call");
  }

  return { call, maxFee: max, expirationLedger: expiration.u32() };
}
