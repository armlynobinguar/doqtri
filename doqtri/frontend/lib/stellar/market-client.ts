/**
 * TemplateMarket writes from the browser (progress/004). Same split as the
 * registry client (contract-client.ts):
 * - `G…` (Freighter): the account signs and submits, and pays the fee, so its
 *   XLM is checked against fee + anything the call itself spends first.
 * - `C…` (passkey smart wallet): the wallet signs the call's auth entry and
 *   /api/chain/relay submits it — wrapped in the FeeForwarder where users pay
 *   their own fees, sponsored through Channels elsewhere.
 *
 * Contract errors are read from the simulation and reported before any
 * wallet prompt opens.
 */
import { StrKey, type contract } from "@stellar/stellar-sdk";
import { Buffer, Client } from "@/lib/bindings/doqtri-market";
import { MARKET_CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import { hexToBytes32 } from "@/lib/stellar/hash";
import { signSorobanTx } from "@/lib/wallet";
import { passkeyWalletFor, payAndRelay, signAndRelay } from "@/lib/passkey-wallet";
import { NATIVE_XLM, USER_PAYS_FEES } from "@/lib/stellar/smart-wallet-config";
import { MAX_MARKET_FEE_STROOPS, marketToken, type MarketToken } from "@/lib/stellar/market-config";
import { marketErrorName, readChainTemplate, readHasPurchased, readMarketConfig, type ChainTemplate } from "@/lib/stellar/market-reads";
import { assertCanPay, assertFunded, getAccountBalance, trustlineState } from "@/lib/stellar/horizon";
import { tokenBalance } from "@/lib/stellar/wallet-balance";
import { buySplit, formatAmount } from "@/lib/market";
import { DoqtriError, mapWalletError } from "@/lib/stellar/errors";

const MESSAGES: Record<string, string> = {
  TemplateExists: "This template is already listed.",
  TemplateNotFound: "This template isn't on-chain.",
  ParentNotFound: "The template this one is based on isn't on-chain.",
  NotListed: "This template has been delisted by its creator.",
  AlreadyPurchased: "You already own this template.",
  SelfPurchase: "That's your own template.",
  PriceTooHigh: "The price changed since you opened this. Review the new price and try again.",
  InvalidPrice: "That price isn't valid.",
  InvalidAmount: "Enter an amount above zero.",
  Paused: "The marketplace is paused right now. Try again later.",
  TokenNotAllowed: "That token isn't accepted by the marketplace.",
};

function isSmartWallet(source: string): boolean {
  return StrKey.isValidContract(source);
}

function client(source: string): Client {
  if (!MARKET_CONTRACT_ID) {
    throw new DoqtriError("UNAVAILABLE", "The template marketplace isn't available on this network.");
  }
  const base = { contractId: MARKET_CONTRACT_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL };
  // A smart wallet can't be a transaction source; the relay supplies one.
  if (isSmartWallet(source)) return new Client(base);
  return new Client({
    ...base,
    publicKey: source,
    signTransaction: async (xdr, opts) => ({ signedTxXdr: await signSorobanTx(xdr, opts?.address ?? source) }),
  });
}

/** Throws the contract's own reason if the simulation already failed. */
function assertSimulates(tx: contract.AssembledTransaction<unknown>): void {
  const result = tx.result as { isErr?: () => boolean } | undefined;
  const error = (tx as { simulation?: { error?: unknown } }).simulation?.error;
  if (!error && !result?.isErr?.()) return;
  const name = marketErrorName(error);
  throw new DoqtriError(name ?? "SIM_FAILED", (name && MESSAGES[name]) || "This would fail on-chain. Reload and try again.");
}

export type MarketReceipt = { txHash: string };

/**
 * Signs and submits with whichever signer `source` is. `spendsXlm` is XLM the
 * call itself moves out of the wallet (an XLM tip or price): a Freighter
 * account must cover it plus the fee, a passkey wallet plus its fee cap.
 */
async function send(
  source: string,
  tx: contract.AssembledTransaction<unknown>,
  spendsXlm: bigint,
): Promise<MarketReceipt> {
  assertSimulates(tx);
  if (!isSmartWallet(source)) {
    await assertCanPay(source, Number(tx.built?.fee ?? 0) + Number(spendsXlm));
    const sent = await tx.signAndSend();
    const txHash = sent.sendTransactionResponse?.hash;
    if (!txHash) throw new DoqtriError("SEND_FAILED", "No transaction hash");
    return { txHash };
  }
  const wallet = passkeyWalletFor(source);
  if (USER_PAYS_FEES) {
    const { hash } = await payAndRelay(tx, wallet, { maxFee: MAX_MARKET_FEE_STROOPS, alsoSpendsXlm: spendsXlm });
    return { txHash: hash };
  }
  return { txHash: await signAndRelay(tx, wallet) };
}

async function run(source: string, build: (c: Client) => Promise<contract.AssembledTransaction<unknown>>, spendsXlm = BigInt(0)) {
  if (!isSmartWallet(source)) await assertFunded(source);
  try {
    return await send(source, await build(client(source)), spendsXlm);
  } catch (e) {
    // Market errors are already worded; the generic mapper would misread
    // their codes as registry errors.
    if (e instanceof DoqtriError) throw e;
    throw mapWalletError(e);
  }
}

const xlmSpent = (token: string, amount: bigint) => (token === NATIVE_XLM ? amount : BigInt(0));

export const TemplateMarket = {
  listTemplate(
    source: string,
    listing: { templateId: string; contentHash: string; token: string; price: bigint; parent: string | null },
  ): Promise<MarketReceipt> {
    return run(source, (c) =>
      c.list_template({
        creator: source,
        template_id: listing.templateId,
        content_hash: Buffer.from(hexToBytes32(listing.contentHash)),
        token: listing.token,
        price: listing.price,
        parent: listing.parent ?? undefined,
      }),
    );
  },

  tip(source: string, templateId: string, token: string, amount: bigint): Promise<MarketReceipt> {
    return run(source, (c) => c.tip({ from: source, template_id: templateId, amount }), xlmSpent(token, amount));
  },

  buy(source: string, templateId: string, token: string, maxPrice: bigint): Promise<MarketReceipt> {
    return run(
      source,
      (c) => c.buy({ buyer: source, template_id: templateId, max_price: maxPrice }),
      xlmSpent(token, maxPrice),
    );
  },

  updatePrice(source: string, templateId: string, price: bigint): Promise<MarketReceipt> {
    return run(source, (c) => c.update_price({ template_id: templateId, price }));
  },

  setListed(source: string, templateId: string, listed: boolean): Promise<MarketReceipt> {
    return run(source, (c) => c.set_listed({ template_id: templateId, listed }));
  },
};

/** Everything the confirm-to-buy sheet shows, read before any wallet prompt. */
export type BuyQuote = {
  template: ChainTemplate;
  token: MarketToken;
  price: bigint;
  /** Who gets what, in the token's smallest unit. */
  creatorCut: bigint;
  parentCut: bigint;
  treasuryCut: bigint;
  /** The buyer's balance in the template's token (null if unreadable). */
  balance: bigint | null;
  /** Network fee in stroops: simulated for Freighter, the cap for passkey wallets. */
  feeStroops: bigint;
  feeIsCap: boolean;
  /** Already bought on-chain (e.g. the copy failed last time): copy again, don't buy. */
  owned: boolean;
  /** Reasons the purchase can't go ahead; empty when it can. */
  problems: string[];
};

/**
 * Prices a purchase for `source` without signing anything: the split, the
 * buyer's balance and trustline, the network fee, and a simulation of the
 * buy itself, which also catches a recipient who can't receive the token.
 */
export async function quoteBuy(source: string, templateId: string): Promise<BuyQuote> {
  const [template, config, owned] = await Promise.all([
    readChainTemplate(templateId),
    readMarketConfig(),
    readHasPurchased(templateId, source).catch(() => false),
  ]);
  if (!template) throw new DoqtriError("NOT_FOUND", MESSAGES.TemplateNotFound);
  const token = marketToken(template.token);
  if (!token) throw new DoqtriError("CONTRACT", MESSAGES.TokenNotAllowed);

  const split = buySplit({
    price: template.price,
    buyer: source,
    creator: template.creator,
    parentCreator: template.parentCreator,
    treasury: config.treasury,
    fees: config,
  });
  const merged = template.parentCreator === template.creator;
  const problems: string[] = [];
  if (owned) {
    return {
      template, token, price: template.price, creatorCut: BigInt(0), parentCut: BigInt(0), treasuryCut: BigInt(0),
      balance: null, feeStroops: BigInt(0), feeIsCap: false, owned, problems,
    };
  }
  if (config.paused) problems.push(MESSAGES.Paused);
  if (!template.listed) problems.push(MESSAGES.NotListed);
  if (source === template.creator) problems.push(MESSAGES.SelfPurchase);

  const smart = isSmartWallet(source);
  const trust = await trustlineState(source, token.asset);
  if (trust === "no-account") problems.push("This wallet isn't on the network yet. Fund it with XLM first.");
  if (trust === "missing") problems.push(`Your wallet has no ${token.code} trustline. Add one in your wallet, then get some ${token.code}.`);
  if (trust === "unauthorized") problems.push(`Your ${token.code} trustline isn't authorized by its issuer.`);

  let balance: bigint | null = null;
  if (trust === "ok") balance = await tokenBalance(source, token.contract).catch(() => null);

  // Simulate the buy itself: catches AlreadyPurchased, a price change, and a
  // creator or parent creator who can't receive this token.
  let feeStroops = MAX_MARKET_FEE_STROOPS;
  if (problems.length === 0) {
    try {
      const tx = await client(source).buy({ buyer: source, template_id: templateId, max_price: template.price });
      assertSimulates(tx);
      if (!smart) feeStroops = BigInt(tx.built?.fee ?? 0);
    } catch (e) {
      problems.push(
        e instanceof DoqtriError && e.code !== "SIM_FAILED"
          ? e.message
          : `This purchase would fail on-chain. The creator may not be able to receive ${token.code} right now.`,
      );
    }
  }

  const xlmNeeded = feeStroops + (token.asset === null ? template.price : BigInt(0));
  if (balance !== null && balance < template.price) {
    problems.push(`You need ${formatAmount(template.price)} ${token.code}; this wallet has ${formatAmount(balance)}.`);
  }
  if (token.asset !== null || balance === null) {
    // Fees are always XLM: check it separately when the price isn't in XLM.
    const xlm = smart
      ? await tokenBalance(source, NATIVE_XLM).catch(() => null)
      : await getAccountBalance(source).then((a) => (a.funded ? BigInt(Math.floor(a.spendable * 1e7)) : BigInt(0)));
    if (xlm !== null && xlm < xlmNeeded) {
      problems.push(`Network fees need up to ${formatAmount(xlmNeeded)} XLM; this wallet has ${formatAmount(xlm)}.`);
    }
  } else if (balance < xlmNeeded) {
    problems.push(`You need ${formatAmount(xlmNeeded)} XLM including network fees; this wallet has ${formatAmount(balance)}.`);
  }

  return {
    template,
    token,
    price: template.price,
    creatorCut: merged ? split.creatorCut + split.parentCut : split.creatorCut,
    parentCut: merged ? BigInt(0) : split.parentCut,
    treasuryCut: split.treasuryCut,
    balance,
    feeStroops,
    feeIsCap: smart,
    owned,
    problems: [...new Set(problems)],
  };
}
