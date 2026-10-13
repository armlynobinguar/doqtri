import { Address, hash, Keypair, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  forwardedTarget,
  marketCallOf,
  validateForwardedMarketWrite,
  validateForwardedWrite,
  validateMarketCall,
  validateMarketWrite,
  type ExpectedTransfer,
  type RelaySubmission,
} from "./relay-validation";

const contract = (seed: string) => StrKey.encodeContract(hash(Buffer.from(seed)));
const addr = (a: string) => Address.fromString(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const str = (s: string) => xdr.ScVal.scvString(s);

const forwarder = contract("forwarder");
const xlm = contract("xlm");
const usdc = contract("usdc");
const market = contract("market");
const registry = contract("registry");
const wallet = contract("wallet");
const creator = Keypair.random().publicKey();
const parentCreator = Keypair.random().publicKey();
const treasury = Keypair.random().publicKey();
const relayer = Keypair.random().publicKey();
const templateId = "abcdefghijklmnop";
const cap = BigInt(10_000_000);

type Inv = xdr.SorobanAuthorizedInvocation;
const invocation = (c: string, name: string, args: xdr.ScVal[], subs: Inv[] = []): Inv =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({ contractAddress: Address.fromString(c).toScAddress(), functionName: name, args }),
    ),
    subInvocations: subs,
  });
const entry = (who: string, inv: Inv) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(who).toScAddress(),
        nonce: xdr.Int64.fromString("9"),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: inv,
  });
const transferInv = (t: ExpectedTransfer, from = wallet) => invocation(t.token, "transfer", [addr(from), addr(t.to), i128(t.amount)]);

const buyArgs = (buyer = wallet, max = BigInt(30_000_000)) => [addr(buyer), str(templateId), i128(max)];
const tipArgs = (from = wallet, amount = BigInt(5_000_000)) => [addr(from), str(templateId), i128(amount)];
const listArgs = (o: { who?: string; price?: bigint; parent?: xdr.ScVal; id?: string } = {}) => [
  addr(o.who ?? wallet),
  str(o.id ?? templateId),
  xdr.ScVal.scvBytes(Buffer.alloc(32, 3)),
  addr(xlm),
  i128(o.price ?? BigInt(0)),
  o.parent ?? xdr.ScVal.scvVoid(),
];

/** The three transfers of a 3 XLM sale with a parent (2.55 / 0.15 / 0.30). */
const saleTransfers: ExpectedTransfer[] = [
  { token: xlm, to: creator, amount: BigInt(25_500_000) },
  { token: xlm, to: parentCreator, amount: BigInt(1_500_000) },
  { token: xlm, to: treasury, amount: BigInt(3_000_000) },
];

describe("market call shapes", () => {
  it("parses each write and names the template", () => {
    expect(validateMarketCall("list_template", listArgs(), wallet)).toEqual({
      fn: "list_template",
      templateId,
      contentHash: "03".repeat(32),
      token: xlm,
      price: BigInt(0),
      parent: null,
    });
    expect(validateMarketCall("list_template", listArgs({ parent: str("qrstuvwxyz234567") }), wallet)).toMatchObject({
      parent: "qrstuvwxyz234567",
    });
    expect(validateMarketCall("buy", buyArgs(), wallet)).toEqual({ fn: "buy", templateId, maxPrice: BigInt(30_000_000) });
    expect(validateMarketCall("tip", tipArgs(), wallet)).toEqual({ fn: "tip", templateId, amount: BigInt(5_000_000) });
    expect(validateMarketCall("update_price", [str(templateId), i128(BigInt(7))], wallet)).toEqual({
      fn: "update_price",
      templateId,
      price: BigInt(7),
    });
    expect(validateMarketCall("set_listed", [str(templateId), xdr.ScVal.scvBool(false)], wallet)).toEqual({
      fn: "set_listed",
      templateId,
      listed: false,
    });
  });

  it("refuses admin functions and anything acting for another wallet", () => {
    expect(() => validateMarketCall("set_fees", [], wallet)).toThrow(/not allowed/);
    expect(() => validateMarketCall("set_token", [], wallet)).toThrow(/not allowed/);
    expect(() => validateMarketCall("list_template", listArgs({ who: contract("other") }), wallet)).toThrow(/creator/);
    expect(() => validateMarketCall("buy", buyArgs(contract("other")), wallet)).toThrow(/buyer/);
    expect(() => validateMarketCall("tip", tipArgs(contract("other")), wallet)).toThrow(/from your wallet/);
  });

  it("refuses ids Doqtri didn't assign and bad amounts", () => {
    expect(() => validateMarketCall("list_template", listArgs({ id: "Not-An-Id" }), wallet)).toThrow(/argument shape/);
    expect(() => validateMarketCall("list_template", listArgs({ price: BigInt(-1) }), wallet)).toThrow(/argument shape/);
    expect(() => validateMarketCall("list_template", listArgs({ parent: str("bad parent") }), wallet)).toThrow(/argument shape/);
    expect(() => validateMarketCall("tip", tipArgs(wallet, BigInt(0)), wallet)).toThrow(/argument shape/);
    expect(() => validateMarketCall("buy", [addr(wallet), str(templateId)], wallet)).toThrow(/argument shape/);
  });
});

describe("sponsored market writes", () => {
  function build(o: { fn?: string; args?: xdr.ScVal[]; subs?: Inv[]; signer?: string; target?: string } = {}): RelaySubmission {
    const fn = o.fn ?? "tip";
    const args = o.args ?? tipArgs();
    const call = new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(o.target ?? market).toScAddress(),
      functionName: fn,
      args,
    });
    const root = invocation(o.target ?? market, fn, args, o.subs ?? [transferInv({ token: xlm, to: creator, amount: BigInt(5_000_000) })]);
    return { func: xdr.HostFunction.hostFunctionTypeInvokeContract(call), auth: [entry(o.signer ?? wallet, root)] };
  }
  const tipTransfer = [{ token: xlm, to: creator, amount: BigInt(5_000_000) }];

  it("accepts a tip whose only nested approval is the transfer to the creator", () => {
    expect(validateMarketWrite(build(), { market, wallet, transfers: tipTransfer })).toMatchObject({ fn: "tip" });
    expect(marketCallOf(build().func, market, wallet)).toMatchObject({ fn: "tip", templateId });
  });

  it("refuses transfers to anyone or of anything else", () => {
    const sub = (t: Partial<ExpectedTransfer>) => [transferInv({ ...tipTransfer[0], ...t })];
    const check = (subs: Inv[]) => () => validateMarketWrite(build({ subs }), { market, wallet, transfers: tipTransfer });
    expect(check(sub({ to: Keypair.random().publicKey() }))).toThrow(/exactly this call/);
    expect(check(sub({ amount: BigInt(5_000_001) }))).toThrow(/exactly this call/);
    expect(check(sub({ token: usdc }))).toThrow(/exactly this call/);
    expect(check([...sub({}), ...sub({})])).toThrow(/exactly this call/);
    expect(check([])).toThrow(/exactly this call/);
  });

  it("refuses other contracts and signers", () => {
    expect(() => validateMarketWrite(build({ target: registry }), { market, wallet, transfers: tipTransfer })).toThrow(/Doqtri market/);
    expect(() => validateMarketWrite(build({ signer: contract("other") }), { market, wallet, transfers: tipTransfer })).toThrow(
      /exactly this call/,
    );
  });

  it("accepts a listing with no nested approvals at all", () => {
    expect(validateMarketWrite(build({ fn: "list_template", args: listArgs(), subs: [] }), { market, wallet, transfers: [] })).toMatchObject({
      fn: "list_template",
    });
  });
});

describe("forwarded market writes (user pays)", () => {
  type O = {
    fn?: string;
    args?: xdr.ScVal[];
    transfers?: Inv[];
    target?: string;
    max?: bigint;
    user?: string;
    extraSub?: boolean;
  };
  function build(o: O = {}): RelaySubmission {
    const max = o.max ?? BigInt(8_000_000);
    const exp = xdr.ScVal.scvU32(5000);
    const fn = o.fn ?? "buy";
    const args = o.args ?? buyArgs();
    const target = o.target ?? market;
    const fwdArgs = [addr(xlm), i128(BigInt(1)), i128(max), exp, addr(target), xdr.ScVal.scvSymbol(fn), xdr.ScVal.scvVec(args), addr(o.user ?? wallet), addr(relayer)];
    const fwd = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(forwarder).toScAddress(), functionName: "forward", args: fwdArgs });
    const subs = [
      invocation(xlm, "approve", [addr(wallet), addr(forwarder), i128(max), exp]),
      invocation(target, fn, args, o.transfers ?? saleTransfers.map((t) => transferInv(t))),
      ...(o.extraSub ? [invocation(xlm, "transfer", [addr(wallet), addr(relayer), i128(BigInt(1))])] : []),
    ];
    const root = invocation(forwarder, "forward", [addr(xlm), i128(max), exp, addr(target), xdr.ScVal.scvSymbol(fn), xdr.ScVal.scvVec(args)], subs);
    return { func: xdr.HostFunction.hostFunctionTypeInvokeContract(fwd), auth: [entry(wallet, root)] };
  }
  const expected = (transfers: ExpectedTransfer[] = saleTransfers) => ({
    forwarder,
    xlm,
    market,
    wallet,
    relayer,
    maxFeeCap: cap,
    transfers,
  });
  const check = (s: RelaySubmission, transfers?: ExpectedTransfer[]) => validateForwardedMarketWrite(s, expected(transfers));

  it("accepts a forwarded buy whose transfers are exactly the split", () => {
    expect(forwardedTarget(build().func)).toBe(market);
    expect(check(build())).toEqual({
      call: { fn: "buy", templateId, maxPrice: BigInt(30_000_000) },
      maxFee: BigInt(8_000_000),
      expirationLedger: 5000,
    });
  });

  it("refuses a buy paying an unexpected recipient or amount", () => {
    const thief = Keypair.random().publicKey();
    const redirected = [saleTransfers[0], { ...saleTransfers[1], to: thief }, saleTransfers[2]].map((t) => transferInv(t));
    expect(() => check(build({ transfers: redirected }))).toThrow(/exactly this forwarded call/);
    const inflated = [{ ...saleTransfers[0], amount: BigInt(99_000_000) }, saleTransfers[1], saleTransfers[2]].map((t) => transferInv(t));
    expect(() => check(build({ transfers: inflated }))).toThrow(/exactly this forwarded call/);
    const reordered = [saleTransfers[1], saleTransfers[0], saleTransfers[2]].map((t) => transferInv(t));
    expect(() => check(build({ transfers: reordered }))).toThrow(/exactly this forwarded call/);
    const fromOther = saleTransfers.map((t) => transferInv(t, contract("other-wallet")));
    expect(() => check(build({ transfers: fromOther }))).toThrow(/exactly this forwarded call/);
  });

  it("refuses when the wallet isn't the buyer or the payer", () => {
    expect(() => check(build({ args: buyArgs(contract("victim")) }))).toThrow(/buyer/);
    expect(() => check(build({ user: contract("victim") }))).toThrow(/your own wallet/);
  });

  it("refuses targets other than the market, and extra approvals", () => {
    expect(() => check(build({ target: registry }))).toThrow(/Doqtri market/);
    expect(() => check(build({ extraSub: true }))).toThrow(/exactly this forwarded call/);
  });

  it("caps the fee at the market cap", () => {
    expect(() => check(build({ max: cap + BigInt(1) }))).toThrow(/outside the allowed range/);
  });

  it("accepts a forwarded listing with no transfers", () => {
    const s = build({ fn: "list_template", args: listArgs(), transfers: [] });
    expect(check(s, []).call).toMatchObject({ fn: "list_template", templateId });
    expect(() => check(s, saleTransfers)).toThrow(/exactly this forwarded call/);
  });

  it("leaves forwarded registry writes to the registry validator", () => {
    const s = build({ target: registry, fn: "register_document", args: [addr(wallet), str("doc"), xdr.ScVal.scvBytes(Buffer.alloc(32, 1))], transfers: [] });
    expect(forwardedTarget(s.func)).toBe(registry);
    expect(() =>
      validateForwardedWrite(build({ fn: "buy" }), { forwarder, xlm, registry, wallet, relayer, maxFeeCap: cap }),
    ).toThrow(/Only the Doqtri registry/);
  });
});
