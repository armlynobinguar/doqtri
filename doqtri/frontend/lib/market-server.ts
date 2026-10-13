/**
 * Server-only marketplace helpers shared by /api/market/* and the relay
 * (progress/004).
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { walletAddressFromEmail } from "@/lib/wallet-address";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { buySplit } from "@/lib/market";
import { readChainTemplate, readMarketConfig } from "@/lib/stellar/market-reads";
import { RelayRejection, type ExpectedTransfer, type MarketCall } from "@/lib/stellar/relay-validation";

/**
 * The wallet a user publishes, buys and tips with on this network: their
 * Freighter account (read from the session's own email), or their passkey
 * wallet. Null for an email account that hasn't created one yet.
 */
export async function userWallet(admin: SupabaseClient, user: Pick<User, "id" | "email">): Promise<string | null> {
  const fromEmail = walletAddressFromEmail(user.email);
  if (fromEmail) return fromEmail;
  const { data } = await admin
    .from("smart_wallets")
    .select("address")
    .eq("user_id", user.id)
    .eq("network", NETWORK)
    .maybeSingle();
  return (data?.address as string | undefined) ?? null;
}

/**
 * The token transfers a market call will ask `wallet` to approve, computed
 * from the ledger — the relay accepts a signed call only if its nested
 * approvals are exactly these.
 */
export async function expectedTransfers(call: MarketCall, wallet: string): Promise<ExpectedTransfer[]> {
  if (call.fn !== "tip" && call.fn !== "buy") return [];
  const template = await readChainTemplate(call.templateId);
  if (!template) throw new RelayRejection("That template isn't on-chain.", 404);
  if (call.fn === "tip") return [{ token: template.token, to: template.creator, amount: call.amount }];

  const config = await readMarketConfig();
  const { transfers } = buySplit({
    price: template.price,
    buyer: wallet,
    creator: template.creator,
    parentCreator: template.parentCreator,
    treasury: config.treasury,
    fees: config,
  });
  return transfers.map((t) => ({ token: template.token, ...t }));
}

export type QuotaResult = "ok" | "user" | "global" | "error";

/** One request against consume_chain_quota (same counter the relay uses). */
export async function consumeQuota(
  admin: SupabaseClient,
  userId: string,
  kind: "publish" | "market",
  userLimit: number,
  globalLimit: number,
): Promise<QuotaResult> {
  const { data, error } = await admin.rpc("consume_chain_quota", {
    p_user_id: userId,
    p_network: NETWORK,
    p_kind: kind,
    p_user_limit: userLimit,
    p_global_limit: globalLimit,
  });
  const row = (data as { allowed: boolean; scope: string | null }[] | null)?.[0];
  if (error || !row) {
    console.error(`[market] quota check failed: ${error?.message ?? "no row"}`);
    return "error";
  }
  if (row.allowed) return "ok";
  return row.scope === "global" ? "global" : "user";
}

export function positiveEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
