/**
 * Server-only marketplace helpers shared by /api/market/* and the relay
 * (progress/004).
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { walletAddressFromEmail } from "@/lib/wallet-address";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { buySplit, sectionSimilarity } from "@/lib/market";
import { readChainTemplate, readMarketConfig, type ChainTemplate } from "@/lib/stellar/market-reads";
import { marketToken } from "@/lib/stellar/market-config";
import { trustlineState } from "@/lib/stellar/horizon";
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

/** How one sale splits, as recorded with the purchase. */
export type SaleRecord = {
  price: bigint;
  creatorCut: bigint;
  parentCut: bigint;
  treasuryCut: bigint;
  parentCreator: string | null;
};

/**
 * What a market call will move, computed from the ledger: the token
 * transfers it will ask `wallet` to approve — the relay accepts a signed call
 * only if its nested approvals are exactly these — and, for `buy`, the split
 * to record with the purchase.
 */
export async function marketCallPlan(
  call: MarketCall,
  wallet: string,
): Promise<{ transfers: ExpectedTransfer[]; sale: SaleRecord | null }> {
  if (call.fn !== "tip" && call.fn !== "buy") return { transfers: [], sale: null };
  const template = await readChainTemplate(call.templateId);
  if (!template) throw new RelayRejection("That template isn't on-chain.", 404);
  if (call.fn === "tip") {
    return { transfers: [{ token: template.token, to: template.creator, amount: call.amount }], sale: null };
  }
  const sale = await saleFor(template, wallet);
  return { transfers: sale.transfers.map((t) => ({ token: template.token, ...t })), sale: sale.record };
}

/** The contract's split of `template`'s current price for `buyer`. */
export async function saleFor(template: ChainTemplate, buyer: string) {
  const config = await readMarketConfig();
  const split = buySplit({
    price: template.price,
    buyer,
    creator: template.creator,
    parentCreator: template.parentCreator,
    treasury: config.treasury,
    fees: config,
  });
  // The parent share goes to the creator when the parent is theirs.
  const merged = template.parentCreator === template.creator;
  const record: SaleRecord = {
    price: template.price,
    creatorCut: merged ? split.creatorCut + split.parentCut : split.creatorCut,
    parentCut: merged ? BigInt(0) : split.parentCut,
    treasuryCut: split.treasuryCut,
    parentCreator: merged ? null : template.parentCreator,
  };
  return { transfers: split.transfers, record };
}

/** market_purchases columns for a sale. */
export function purchaseColumns(sale: SaleRecord) {
  return {
    amount: sale.price.toString(),
    creator_cut: sale.creatorCut.toString(),
    parent_cut: sale.parentCut.toString(),
    treasury_cut: sale.treasuryCut.toString(),
    parent_creator_wallet: sale.parentCreator,
  };
}

/**
 * Can `address` receive `token`? Contract wallets always can; a `G…` account
 * must exist and, for anything but XLM, hold an authorized trustline. A sale
 * paying someone who can't receive fails as a whole, so this is checked
 * before a paid template is listed.
 */
export async function canReceive(address: string, token: string): Promise<boolean> {
  const t = marketToken(token);
  if (!t) return false;
  return (await trustlineState(address, t.asset)) === "ok";
}

/** Refresh a template's cached chain state (price, listing, sales, earned). */
export async function syncTemplate(admin: SupabaseClient, templateId: string): Promise<ChainTemplate | null> {
  const chain = await readChainTemplate(templateId);
  if (!chain) return null;
  const { error } = await admin
    .from("market_templates")
    .update({
      price: chain.price.toString(),
      status: chain.listed ? "listed" : "delisted",
      sales: chain.sales,
      earned: chain.earned.toString(),
    })
    .eq("id", templateId)
    .neq("status", "pending");
  if (error) console.error(`[market] ${templateId} not synced: ${error.message}`);
  return chain;
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

/** One side of a copy report, as the admin queue shows it. */
export type ReportedTemplate = {
  id: string;
  title: string;
  creatorWallet: string;
  contentHash: string;
  body: string;
  hidden: boolean;
  /** On-chain first-listed time (unix seconds), or null if unreadable. */
  listedAt: number | null;
};

export type ReportItem = {
  id: string;
  status: "open" | "upheld" | "dismissed";
  reason: string;
  createdAt: string;
  reported: ReportedTemplate;
  original: ReportedTemplate;
  sameHash: boolean;
  /** Share of headings in common, 0–1. */
  similarity: number;
  /** Which side was listed on-chain first, by the contract's timestamps. */
  earlier: "reported" | "original" | "unknown";
};

/**
 * The copy-report queue for /admin/reports, newest first, with everything an
 * admin needs to decide: both bodies, hash equality, heading overlap, and
 * the on-chain listing times (the earlier listing wins).
 */
export async function loadReportQueue(admin: SupabaseClient, limit = 100): Promise<ReportItem[]> {
  const { data: reports, error } = await admin
    .from("market_reports")
    .select("id, status, reason, created_at, template_id, original_id")
    .eq("network", NETWORK)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load reports: ${error.message}`);
  if (!reports?.length) return [];

  const ids = [...new Set(reports.flatMap((r) => [r.template_id as string, r.original_id as string]))];
  const { data: rows } = await admin
    .from("market_templates")
    .select("id, title, creator_wallet, content_hash, body, hidden")
    .in("id", ids);
  const listedAt = new Map<string, number | null>();
  await Promise.all(
    ids.map(async (id) => listedAt.set(id, (await readChainTemplate(id).catch(() => null))?.createdAt ?? null)),
  );
  const side = new Map<string, ReportedTemplate>(
    (rows ?? []).map((r) => [
      r.id as string,
      {
        id: r.id,
        title: r.title,
        creatorWallet: r.creator_wallet,
        contentHash: r.content_hash,
        body: r.body,
        hidden: r.hidden,
        listedAt: listedAt.get(r.id) ?? null,
      },
    ]),
  );

  // Open reports first, each group newest first (created_at order is kept).
  const rank = (status: string) => (status === "open" ? 0 : 1);
  return [...reports].sort((a, b) => rank(a.status) - rank(b.status)).flatMap((r) => {
    const reported = side.get(r.template_id);
    const original = side.get(r.original_id);
    if (!reported || !original) return [];
    const earlier =
      reported.listedAt === null || original.listedAt === null || reported.listedAt === original.listedAt
        ? "unknown"
        : reported.listedAt < original.listedAt
          ? "reported"
          : "original";
    return [
      {
        id: r.id,
        status: r.status,
        reason: r.reason,
        createdAt: r.created_at,
        reported,
        original,
        sameHash: reported.contentHash === original.contentHash,
        similarity: sectionSimilarity(reported.body, original.body),
        earlier,
      } satisfies ReportItem,
    ];
  });
}
