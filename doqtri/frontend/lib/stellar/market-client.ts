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
import { MAX_MARKET_FEE_STROOPS } from "@/lib/stellar/market-config";
import { marketErrorName } from "@/lib/stellar/market-reads";
import { assertCanPay, assertFunded } from "@/lib/stellar/horizon";
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
