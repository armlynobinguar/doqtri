/**
 * Reads from the TemplateMarket contract (progress/004). Free simulations, no
 * signer: usable from the browser, the API routes and the relay alike.
 */
import { Buffer, Client, Errors, type Template } from "@/lib/bindings/doqtri-market";
import { MARKET_CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import type { MarketFees } from "@/lib/market";

export type ChainTemplate = {
  creator: string;
  contentHash: string;
  token: string;
  price: bigint;
  parent: string | null;
  parentCreator: string | null;
  listed: boolean;
  sales: number;
  earned: bigint;
  tips: bigint;
  createdAt: number;
};

export type ChainMarketConfig = MarketFees & { treasury: string; paused: boolean };

export function marketReadClient(): Client {
  if (!MARKET_CONTRACT_ID) throw new Error("The template marketplace isn't available on this network.");
  return new Client({ contractId: MARKET_CONTRACT_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
}

/** The contract error name in a simulation's HostError text, e.g. "TemplateNotFound". */
export function marketErrorName(simulationError: unknown): string | null {
  const code = /Error\(Contract, #(\d+)\)/.exec(String(simulationError ?? ""))?.[1];
  return code ? (Errors[Number(code) as keyof typeof Errors]?.message ?? null) : null;
}

function simulationError(tx: unknown): unknown {
  return (tx as { simulation?: { error?: unknown } }).simulation?.error;
}

function toChainTemplate(t: Template): ChainTemplate {
  return {
    creator: String(t.creator),
    contentHash: Buffer.from(t.content_hash).toString("hex"),
    token: String(t.token),
    price: BigInt(t.price),
    parent: t.parent ?? null,
    parentCreator: t.parent_creator ? String(t.parent_creator) : null,
    listed: Boolean(t.listed),
    sales: Number(t.sales),
    earned: BigInt(t.earned),
    tips: BigInt(t.tips),
    createdAt: Number(t.created_at),
  };
}

/**
 * Null only when the contract says the template doesn't exist; transport and
 * RPC failures throw, so callers never mistake an outage for "not listed".
 */
export async function readChainTemplate(templateId: string): Promise<ChainTemplate | null> {
  const tx = await marketReadClient().get_template({ template_id: templateId });
  const result = tx.result;
  if (result.isErr()) {
    if (marketErrorName(simulationError(tx)) === "TemplateNotFound") return null;
    throw new Error(`get_template failed: ${String(simulationError(tx) ?? result.unwrapErr().message)}`);
  }
  return toChainTemplate(result.unwrap());
}

export async function readMarketConfig(): Promise<ChainMarketConfig> {
  const tx = await marketReadClient().get_config();
  const c = tx.result;
  return {
    creatorBps: Number(c.creator_bps),
    parentBps: Number(c.parent_bps),
    treasuryBps: Number(c.treasury_bps),
    treasury: String(c.treasury),
    paused: Boolean(c.paused),
  };
}

export async function readHasPurchased(templateId: string, buyer: string): Promise<boolean> {
  const tx = await marketReadClient().has_purchased({ template_id: templateId, buyer });
  return Boolean(tx.result);
}
