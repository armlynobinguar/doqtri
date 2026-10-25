import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { marketToken } from "@/lib/stellar/market-config";
import { isTemplateCategory, templateOutline, type CommunityTemplate } from "@/lib/market";

/**
 * The gallery's Community tab (progress/004): listed, non-hidden templates on
 * this network. Free templates come with their full body; paid ones with
 * their headings only — the body of a paid template leaves the server only
 * through /api/market/claim, after the on-chain purchase check.
 */

const SORTS = {
  popular: [{ column: "uses", ascending: false }, { column: "listed_at", ascending: false }],
  newest: [{ column: "listed_at", ascending: false }],
  price: [{ column: "price", ascending: true }, { column: "listed_at", ascending: false }],
} as const;

const LIMIT = 200;

export async function GET(request: Request) {
  if (!MARKET_CONTRACT_ID) return Response.json({ templates: [], available: false });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const sort = SORTS[(params.get("sort") ?? "popular") as keyof typeof SORTS] ?? SORTS.popular;
  const category = params.get("category");

  let query = createSupabaseAdminClient()
    .from("market_templates")
    .select("id, title, category, description, body, price::text, token, creator_id, creator_wallet, uses, sales, parent_id, listed_at")
    .eq("network", NETWORK)
    .eq("status", "listed")
    .eq("hidden", false);
  if (isTemplateCategory(category)) query = query.eq("category", category);
  if (params.get("free") === "1") query = query.eq("price", 0);
  for (const { column, ascending } of sort) query = query.order(column, { ascending });

  const { data: rows, error } = await query.limit(LIMIT);
  if (error) {
    console.error(`[market/templates] ${error.message}`);
    return Response.json({ error: "Community templates couldn't be loaded." }, { status: 500 });
  }

  const parentIds = [...new Set(rows.map((r) => r.parent_id).filter((id): id is string => Boolean(id)))];
  const parents = new Map<string, NonNullable<CommunityTemplate["parent"]>>();
  if (parentIds.length) {
    const { data } = await createSupabaseAdminClient()
      .from("market_templates")
      .select("id, title, creator_id, creator_wallet")
      .in("id", parentIds);
    for (const p of data ?? []) {
      parents.set(p.id, { id: p.id, title: p.title, creatorWallet: p.creator_wallet, creatorGone: p.creator_id === null });
    }
  }

  // Templates this user already bought: "Use again" instead of "Buy".
  const { data: bought } = await createSupabaseAdminClient()
    .from("market_purchases")
    .select("template_id")
    .eq("buyer_id", user.id)
    .eq("network", NETWORK);
  const owned = new Set((bought ?? []).map((p) => p.template_id as string));

  const templates: CommunityTemplate[] = rows.map((r) => {
    const free = BigInt(r.price) === BigInt(0);
    return {
      id: r.id,
      title: r.title,
      category: r.category,
      description: r.description,
      preview: free ? r.body : templateOutline(r.body),
      free,
      price: r.price,
      token: r.token,
      tokenCode: marketToken(r.token)?.code ?? "?",
      creatorWallet: r.creator_wallet,
      // A deleted creator's template stays listed (D-63): "Former user".
      creatorGone: r.creator_id === null,
      mine: r.creator_id === user.id,
      owned: owned.has(r.id),
      uses: r.uses,
      sales: r.sales,
      parent: r.parent_id ? (parents.get(r.parent_id) ?? null) : null,
      listedAt: r.listed_at,
    };
  });
  return Response.json({ templates, available: true });
}
