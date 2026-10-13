import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { TEMPLATE_ID_PATTERN } from "@/lib/market";
import { syncTemplate } from "@/lib/market-server";

/**
 * Re-reads one of the caller's templates from the contract after they change
 * its price or listing (progress/004), so the gallery shows what the chain
 * says. Creator only; the chain is the source either way.
 */
export async function POST(request: Request) {
  if (!MARKET_CONTRACT_ID) return Response.json({ error: "The template marketplace isn't available on this network." }, { status: 503 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  let templateId = "";
  try {
    const body = (await request.json()) as { templateId?: unknown };
    if (typeof body.templateId === "string") templateId = body.templateId;
  } catch {
    // handled below
  }
  if (!TEMPLATE_ID_PATTERN.test(templateId)) return Response.json({ error: "Invalid template id" }, { status: 400 });

  const admin = createSupabaseAdminClient();
  const { data: row } = await admin
    .from("market_templates")
    .select("id")
    .eq("id", templateId)
    .eq("network", NETWORK)
    .eq("creator_id", user.id)
    .neq("status", "pending")
    .maybeSingle();
  if (!row) return Response.json({ error: "That template isn't yours." }, { status: 404 });

  let chain;
  try {
    chain = await syncTemplate(admin, templateId);
  } catch {
    return Response.json({ error: "The ledger couldn't be reached. Try again in a moment." }, { status: 503 });
  }
  if (!chain) return Response.json({ error: "That template isn't on-chain." }, { status: 404 });
  return Response.json({ templateId, price: chain.price.toString(), listed: chain.listed, sales: chain.sales });
}
