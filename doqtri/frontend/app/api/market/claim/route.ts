import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { readHasPurchased } from "@/lib/stellar/market-reads";
import { TEMPLATE_ID_PATTERN } from "@/lib/market";
import { userWallet } from "@/lib/market-server";
import { uniqueTitle } from "@/lib/title";

/**
 * "Use template" on a community template (progress/004): copies it into the
 * caller's vault, server-side. It can't go through POST /api/notes, which
 * takes the body from the browser — a paid body never reaches the browser
 * before this check.
 *
 * Free templates need no transaction. Paid ones need `has_purchased` to be
 * true on-chain for the caller's wallet; the chain decides, never the client.
 * Owners can always copy their own, and buyers can copy again for free.
 * The copy remembers its source, so re-publishing it links the parent.
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
  let txHash: string | null = null;
  try {
    const body = (await request.json()) as { templateId?: unknown; txHash?: unknown };
    if (typeof body.templateId === "string") templateId = body.templateId;
    if (typeof body.txHash === "string" && /^[0-9a-f]{64}$/.test(body.txHash)) txHash = body.txHash;
  } catch {
    // handled below
  }
  if (!TEMPLATE_ID_PATTERN.test(templateId)) return fail("Invalid template id", 400);

  const admin = createSupabaseAdminClient();
  const { data: row } = await admin
    .from("market_templates")
    .select("id, title, body, price::text, status, hidden, creator_id")
    .eq("id", templateId)
    .eq("network", NETWORK)
    .maybeSingle();
  if (!row || row.status === "pending") return fail("That template isn't in the gallery.", 404);

  const price = BigInt(row.price);
  const own = row.creator_id === user.id;
  if (!own && price === BigInt(0) && (row.status !== "listed" || row.hidden)) {
    return fail("That template is no longer available.", 410);
  }
  if (!own && price > BigInt(0)) {
    const wallet = await userWallet(admin, user);
    let purchased = false;
    try {
      purchased = wallet ? await readHasPurchased(templateId, wallet) : false;
    } catch (error) {
      console.error(`[market/claim] ${templateId}: ${(error as Error).message}`);
      return fail("The ledger couldn't be reached. Try again in a moment.", 503);
    }
    if (!purchased) return fail("Buy this template first.", 402);
    // Freighter buyers submit themselves; record what they sent. Passkey
    // purchases were recorded by the relay. Either way the chain decided.
    await admin
      .from("market_purchases")
      .upsert(
        { network: NETWORK, template_id: templateId, buyer_id: user.id, buyer_wallet: wallet, tx_hash: txHash, amount: row.price },
        { onConflict: "template_id,buyer_wallet", ignoreDuplicates: true },
      );
  }

  const { data: existing, error: titlesError } = await admin.from("documents").select("title").eq("user_id", user.id);
  if (titlesError) return fail(titlesError.message, 500);
  const title = uniqueTitle(row.title, (existing ?? []).map((d: { title: string }) => d.title));

  const { data: inserted, error } = await admin
    .from("documents")
    .insert({ user_id: user.id, title, markdown: `# ${title}\n\n${row.body}`, source_template_id: templateId })
    .select("id")
    .single();
  if (error) return fail(error.message, 500);

  if (!own) {
    const { error: useError } = await admin.rpc("market_record_use", { p_template_id: templateId });
    if (useError) console.error(`[market/claim] use of ${templateId} not counted: ${useError.message}`);
  }
  return Response.json({ id: inserted.id, title });
}
