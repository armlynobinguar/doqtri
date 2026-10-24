import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { readChainTemplate, readHasPurchased } from "@/lib/stellar/market-reads";
import { TEMPLATE_ID_PATTERN } from "@/lib/market";
import { purchaseColumns, saleFor, userWallet } from "@/lib/market-server";
import { insertWorkspaceDocument, personalWorkspaceId } from "@/lib/workspace-docs";

/**
 * "Use template" on a community template (progress/004): copies it into the
 * caller's vault, server-side. It can't go through POST /api/notes, which
 * takes the body from the browser — a paid body never reaches the browser
 * before this check.
 *
 * Free templates need no transaction. Paid ones need `has_purchased` to be
 * true on-chain for the caller's wallet; the chain decides, never the client
 * — including what "paid" means: the price and listing are read from the
 * contract, not the gallery's cache, so a price change can't slip through.
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
    .select("id, title, body, status, hidden, creator_id")
    .eq("id", templateId)
    .eq("network", NETWORK)
    .maybeSingle();
  if (!row || row.status === "pending") return fail("That template isn't in the gallery.", 404);

  const own = row.creator_id === user.id;
  let chain;
  try {
    chain = await readChainTemplate(templateId);
  } catch (error) {
    console.error(`[market/claim] ${templateId}: ${(error as Error).message}`);
    return fail("The ledger couldn't be reached. Try again in a moment.", 503);
  }
  if (!chain) return fail("That template isn't on-chain.", 404);

  if (!own) {
    const wallet = await userWallet(admin, user);
    let purchased = false;
    if (wallet) {
      try {
        purchased = await readHasPurchased(templateId, wallet);
      } catch (error) {
        console.error(`[market/claim] ${templateId}: ${(error as Error).message}`);
        return fail("The ledger couldn't be reached. Try again in a moment.", 503);
      }
    }
    // Bought before: copy again for free, even if since delisted or hidden.
    if (!purchased) {
      if (!chain.listed || row.hidden) return fail("That template is no longer available.", 410);
      if (chain.price > BigInt(0)) return fail("Buy this template first.", 402);
    } else if (wallet) {
      // Freighter buyers submit themselves; record what they sent. Passkey
      // purchases were recorded by the relay. Either way the chain decided.
      const { data: recorded } = await admin
        .from("market_purchases")
        .select("template_id")
        .eq("template_id", templateId)
        .eq("buyer_wallet", wallet)
        .maybeSingle();
      if (!recorded) {
        const { record } = await saleFor(chain, wallet);
        const { error: purchaseError } = await admin.from("market_purchases").insert({
          network: NETWORK,
          template_id: templateId,
          buyer_id: user.id,
          buyer_wallet: wallet,
          tx_hash: txHash,
          ...purchaseColumns(record),
        });
        if (purchaseError) console.error(`[market/claim] purchase of ${templateId} not recorded: ${purchaseError.message}`);
      }
    }
  }

  // The copy goes into the user's personal workspace, like any new note.
  let workspaceId: string;
  try {
    workspaceId = await personalWorkspaceId(admin, user.id);
  } catch (error) {
    return fail((error as Error).message, 500);
  }
  const inserted = await insertWorkspaceDocument(admin, {
    userId: user.id,
    workspaceId,
    title: row.title,
    markdown: (title) => `# ${title}\n\n${row.body}`,
    extra: { source_template_id: templateId },
  });
  if ("error" in inserted) return fail(inserted.error, 500);

  if (!own) {
    const { error: useError } = await admin.rpc("market_record_use", { p_template_id: templateId });
    if (useError) console.error(`[market/claim] use of ${templateId} not counted: ${useError.message}`);
  }
  return Response.json({ id: inserted.id, title: inserted.title });
}
