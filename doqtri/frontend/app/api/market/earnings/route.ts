import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { marketToken } from "@/lib/stellar/market-config";
import { syncTemplate, userWallet } from "@/lib/market-server";
import type { EarningsRoyalty, EarningsSummary, EarningsTemplate } from "@/lib/market";

/**
 * The creator dashboard's data (progress/004): the caller's templates with
 * sales, earnings and tips re-read from the contract (and the cache
 * refreshed), recent sales with their transactions, derivatives of each
 * template, and the royalties those derivatives paid the caller.
 */

const RECENT_SALES = 20;

export async function GET() {
  if (!MARKET_CONTRACT_ID) return Response.json({ error: "The template marketplace isn't available on this network." }, { status: 503 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const wallet = await userWallet(admin, user);

  const { data: rows, error } = await admin
    .from("market_templates")
    .select("id, title, hidden, token, uses, listed_at, parent_id")
    .eq("network", NETWORK)
    .eq("creator_id", user.id)
    .neq("status", "pending")
    .order("listed_at", { ascending: false });
  if (error) return Response.json({ error: "Your templates couldn't be loaded." }, { status: 500 });
  const ids = rows.map((r) => r.id as string);

  const [chains, related] = await Promise.all([
    Promise.all(ids.map((id) => syncTemplate(admin, id).catch(() => null))),
    ids.length
      ? Promise.all([
          admin
            .from("market_purchases")
            .select("template_id, buyer_wallet, amount::text, creator_cut::text, tx_hash, created_at")
            .in("template_id", ids)
            .order("created_at", { ascending: false })
            .limit(RECENT_SALES * 10),
          admin.from("market_templates").select("id, title, creator_wallet, sales, parent_id").in("parent_id", ids).neq("status", "pending"),
          admin
            .from("market_templates")
            .select("id, title")
            .in("id", rows.map((r) => r.parent_id).filter(Boolean) as string[]),
        ])
      : Promise.resolve(null),
  ]);
  const [sales, derived, parents] = related ?? [{ data: [] }, { data: [] }, { data: [] }];
  const parentTitle = new Map((parents.data ?? []).map((p) => [p.id as string, p.title as string]));

  const templates: EarningsTemplate[] = rows.map((r, i) => {
    const chain = chains[i];
    return {
      id: r.id,
      title: r.title,
      listed: chain?.listed ?? false,
      hidden: r.hidden,
      price: (chain?.price ?? BigInt(0)).toString(),
      token: r.token,
      tokenCode: marketToken(r.token)?.code ?? "?",
      sales: chain?.sales ?? 0,
      earned: (chain?.earned ?? BigInt(0)).toString(),
      tips: (chain?.tips ?? BigInt(0)).toString(),
      uses: r.uses,
      listedAt: r.listed_at,
      parent: r.parent_id ? { id: r.parent_id, title: parentTitle.get(r.parent_id) ?? "Unknown template" } : null,
      recentSales: (sales.data ?? [])
        .filter((s) => s.template_id === r.id)
        .slice(0, RECENT_SALES)
        .map((s) => ({
          buyerWallet: s.buyer_wallet,
          amount: s.amount,
          creatorCut: s.creator_cut ?? s.amount,
          txHash: s.tx_hash,
          createdAt: s.created_at,
        })),
      derived: (derived.data ?? [])
        .filter((d) => d.parent_id === r.id)
        .map((d) => ({ id: d.id, title: d.title, creatorWallet: d.creator_wallet, sales: d.sales })),
    };
  });

  // Royalties: sales of other creators' templates whose parent was this wallet's.
  const royalties: EarningsRoyalty[] = [];
  if (wallet) {
    const { data: paid } = await admin
      .from("market_purchases")
      .select("template_id, parent_cut::text")
      .eq("network", NETWORK)
      .eq("parent_creator_wallet", wallet);
    const byTemplate = new Map<string, { sales: number; total: bigint }>();
    for (const p of paid ?? []) {
      const entry = byTemplate.get(p.template_id) ?? { sales: 0, total: BigInt(0) };
      entry.sales += 1;
      entry.total += BigInt(p.parent_cut ?? "0");
      byTemplate.set(p.template_id, entry);
    }
    if (byTemplate.size) {
      const { data: kids } = await admin
        .from("market_templates")
        .select("id, title, token, parent_id")
        .in("id", [...byTemplate.keys()]);
      const kidParents = (kids ?? []).map((k) => k.parent_id).filter(Boolean) as string[];
      const { data: parentRows } = kidParents.length
        ? await admin.from("market_templates").select("id, title").in("id", kidParents)
        : { data: [] };
      const titles = new Map((parentRows ?? []).map((p) => [p.id as string, p.title as string]));
      for (const k of kids ?? []) {
        const entry = byTemplate.get(k.id)!;
        royalties.push({
          templateId: k.id,
          title: k.title,
          parentId: k.parent_id,
          parentTitle: titles.get(k.parent_id) ?? "Unknown template",
          tokenCode: marketToken(k.token)?.code ?? "?",
          sales: entry.sales,
          total: entry.total.toString(),
        });
      }
    }
  }

  const totals = new Map<string, { earned: bigint; tips: bigint; royalties: bigint }>();
  const bucket = (code: string) => {
    const t = totals.get(code) ?? { earned: BigInt(0), tips: BigInt(0), royalties: BigInt(0) };
    totals.set(code, t);
    return t;
  };
  for (const t of templates) {
    const b = bucket(t.tokenCode);
    b.earned += BigInt(t.earned);
    b.tips += BigInt(t.tips);
  }
  for (const r of royalties) bucket(r.tokenCode).royalties += BigInt(r.total);

  const summary: EarningsSummary = {
    wallet,
    templates,
    royalties,
    totals: [...totals].map(([tokenCode, t]) => ({
      tokenCode,
      earned: t.earned.toString(),
      tips: t.tips.toString(),
      royalties: t.royalties.toString(),
    })),
  };
  return Response.json(summary);
}
