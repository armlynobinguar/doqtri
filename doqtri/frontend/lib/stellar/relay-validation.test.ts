import { Address, hash, Keypair, nativeToScVal, Networks, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  deployedContractAddress,
  deployerAddress,
  parseRelayBody,
  RelayRejection,
  validateRegistryWrite,
  validateWalletAdmin,
  validateWalletDeploy,
  type RelaySubmission,
} from "./relay-validation";

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
