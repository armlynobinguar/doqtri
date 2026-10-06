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
import { Address, hash, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";

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

export const REGISTRY_FUNCTIONS = ["register_document", "update_document", "set_node_status"] as const;
export type RegistryFunction = (typeof REGISTRY_FUNCTIONS)[number];

export type RegistryWrite = { fn: RegistryFunction; docId: string };

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
 * A DoqtriRegistry write signed by the caller's own smart wallet: one
 * invocation of one registry function on exactly `registry`, with the
 * argument shapes the contract declares, and one auth entry from `wallet`
 * authorizing exactly that invocation and nothing nested.
 *
 * The caller still has to check that `docId` is one of the user's notes.
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
  const fn = invoke.functionName().toString() as RegistryFunction;
  if (!REGISTRY_FUNCTIONS.includes(fn)) {
    throw new RelayRejection("That registry function is not allowed");
  }

  const args = invoke.args();
  let docArg: xdr.ScVal | undefined;
  if (fn === "register_document") {
    if (
      args.length !== 3 ||
      args[0].switch().name !== "scvAddress" ||
      Address.fromScAddress(args[0].address()).toString() !== expected.wallet ||
      !isString(args[1]) ||
      !isHash(args[2])
    ) {
      throw new RelayRejection("register_document must name your wallet as the owner");
    }
    docArg = args[1];
  } else if (fn === "update_document") {
    if (args.length !== 2 || !isString(args[0]) || !isHash(args[1])) {
      throw new RelayRejection("update_document has an invalid argument shape");
    }
    docArg = args[0];
  } else {
    if (
      args.length !== 5 ||
      !isString(args[0]) ||
      !isString(args[1]) ||
      args[2].switch().name !== "scvVec" ||
      !isString(args[3]) ||
      !isString(args[4])
    ) {
      throw new RelayRejection("set_node_status has an invalid argument shape");
    }
    docArg = args[0];
  }

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

  return { fn, docId: docArg.str().toString() };
}
