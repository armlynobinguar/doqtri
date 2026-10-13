import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { readChainTemplate } from "@/lib/stellar/market-reads";
import { TEMPLATE_ID_PATTERN } from "@/lib/market";

/**
 * Step 2 of publishing (progress/004): after `list_template` lands, check the
 * ledger agrees with the draft — same creator, hash, token, price and parent —
 * and only then show the template in the gallery. The on-chain listing time
 * becomes `listed_at`: that is what "who published first" is judged by.
 *
 * Idempotent, and it never trusts the browser: a client that skips signing
 * or signs something else is left with a draft nobody sees.
 */

function fail(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  if (!MARKET_CONTRACT_ID) return fail("The template marketplace isn't available on this network.", 503);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Sign in to continue.", 401);

  let templateId = "";
  try {
    const body = (await request.json()) as { templateId?: unknown };
    if (typeof body.templateId === "string") templateId = body.templateId;
  } catch {
    // handled below
  }
  if (!TEMPLATE_ID_PATTERN.test(templateId)) return fail("Invalid template id", 400);

  const admin = createSupabaseAdminClient();
  const { data: row } = await admin
    .from("market_templates")
    .select("id, status, creator_wallet, content_hash, token, price::text, parent_id")
    .eq("id", templateId)
    .eq("network", NETWORK)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (!row) return fail("That template isn't yours.", 404);
  if (row.status !== "pending") return Response.json({ templateId, status: row.status });

  let chain;
  try {
    chain = await readChainTemplate(templateId);
  } catch (error) {
    console.error(`[market/confirm] ${templateId}: ${(error as Error).message}`);
    return fail("The ledger couldn't be reached. Try again in a moment.", 503);
  }
  if (!chain) return fail("The listing isn't on-chain yet. Try again in a moment.", 409);

  if (
    chain.creator !== row.creator_wallet ||
    chain.contentHash !== row.content_hash ||
    chain.token !== row.token ||
    chain.price !== BigInt(row.price) ||
    chain.parent !== (row.parent_id ?? null)
  ) {
    console.error(`[market/confirm] ${templateId}: on-chain listing doesn't match the draft`);
    return fail("The on-chain listing doesn't match this template, so it won't be shown.", 409);
  }

  const status = chain.listed ? "listed" : "delisted";
  const { error } = await admin
    .from("market_templates")
    .update({
      status,
      listed_at: new Date(chain.createdAt * 1000).toISOString(),
      sales: chain.sales,
      earned: chain.earned.toString(),
    })
    .eq("id", templateId);
  if (error) {
    console.error(`[market/confirm] ${templateId} listed but not recorded: ${error.message}`);
    return fail("Listed on-chain, but the gallery couldn't be updated. Try again.", 500);
  }
  return Response.json({ templateId, status });
}
