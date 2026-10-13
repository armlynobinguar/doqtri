import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { sha256Hex } from "@/lib/stellar/hash";
import { MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { marketToken, PAID_TEMPLATES_ENABLED } from "@/lib/stellar/market-config";
import {
  isTemplateCategory,
  MAX_TEMPLATE_BODY,
  MAX_TEMPLATE_DESCRIPTION,
  MAX_TEMPLATE_TITLE,
  newTemplateId,
  templateBodyFromNote,
} from "@/lib/market";
import { consumeQuota, positiveEnv, userWallet } from "@/lib/market-server";

/**
 * Step 1 of publishing a note as a community template (progress/004): freeze
 * the note into a snapshot, assign the template id, and return its hash. The
 * browser then signs `list_template` with exactly these values (the relay
 * refuses anything else), and step 2 (./confirm) checks the ledger before
 * the template shows in the gallery.
 *
 * If the note was made from a community template, that template is the
 * parent and earns its creator's share of every sale. The creator can't
 * remove it.
 */

const PUBLISH_PER_USER = positiveEnv(process.env.MARKET_PUBLISH_PER_USER_DAILY, 10);
const PUBLISH_GLOBAL = positiveEnv(process.env.MARKET_PUBLISH_GLOBAL_DAILY, 500);

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

  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid JSON", 400);
  }

  const noteId = typeof input.noteId === "string" ? input.noteId : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const token = marketToken(typeof input.token === "string" ? input.token : "");
  let price: bigint;
  try {
    price = BigInt(typeof input.price === "string" ? input.price : "x");
  } catch {
    return fail("Price must be a whole number of the token's smallest unit.", 400);
  }

  if (!title || title.length > MAX_TEMPLATE_TITLE) return fail(`Give the template a title (up to ${MAX_TEMPLATE_TITLE} characters).`, 400);
  if (description.length > MAX_TEMPLATE_DESCRIPTION) return fail(`Keep the description under ${MAX_TEMPLATE_DESCRIPTION} characters.`, 400);
  if (!isTemplateCategory(input.category)) return fail("Pick a category.", 400);
  if (!token) return fail("That token isn't accepted by the marketplace.", 400);
  if (price < BigInt(0)) return fail("The price can't be negative.", 400);
  if (price > BigInt(0) && !PAID_TEMPLATES_ENABLED) return fail("Paid templates aren't open yet. Publish it for free.", 400);
  if (price > BigInt(0) && price < token.minPrice) return fail(`The lowest price in ${token.code} is ${Number(token.minPrice) / 1e7}.`, 400);

  const admin = createSupabaseAdminClient();
  const wallet = await userWallet(admin, user);
  if (!wallet) return fail("Create your passkey wallet first: templates are listed on-chain in your name.", 409);

  const { data: note } = await admin
    .from("documents")
    .select("id, markdown, source_template_id")
    .eq("id", noteId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!note) return fail("That note isn't in your vault.", 404);

  const body = templateBodyFromNote(note.markdown ?? "");
  if (!body.trim()) return fail("This note is empty. Write something before publishing it.", 400);
  if (body.length > MAX_TEMPLATE_BODY) return fail("This note is too long to publish as a template.", 413);

  // Only a parent that exists on-chain: the contract refuses any other.
  let parent: { id: string; title: string } | null = null;
  if (note.source_template_id) {
    const { data } = await admin
      .from("market_templates")
      .select("id, title, status")
      .eq("id", note.source_template_id)
      .eq("network", NETWORK)
      .maybeSingle();
    if (data && data.status !== "pending") parent = { id: data.id, title: data.title };
  }

  const quota = await consumeQuota(admin, user.id, "publish", PUBLISH_PER_USER, PUBLISH_GLOBAL);
  if (quota === "error") return fail("Publishing is temporarily unavailable.", 503);
  if (quota === "global") return fail("Publishing is paused for today. Try again tomorrow.", 429);
  if (quota === "user") return fail("You've reached today's limit for publishing templates.", 429);

  const id = newTemplateId();
  const contentHash = await sha256Hex(body);
  const { error } = await admin.from("market_templates").insert({
    id,
    network: NETWORK,
    creator_id: user.id,
    creator_wallet: wallet,
    note_id: note.id,
    title,
    category: input.category,
    description,
    body,
    content_hash: contentHash,
    token: token.contract,
    price: price.toString(),
    parent_id: parent?.id ?? null,
  });
  if (error) {
    console.error(`[market/publish] draft not saved: ${error.message}`);
    return fail("The template could not be prepared. Try again.", 500);
  }

  return Response.json({
    templateId: id,
    contentHash,
    token: token.contract,
    price: price.toString(),
    parent,
    wallet,
  });
}
