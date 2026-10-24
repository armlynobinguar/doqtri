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
import { canReceive, consumeQuota, positiveEnv, userWallet } from "@/lib/market-server";
import { loadMemberDocument } from "@/lib/workspace-docs";

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

  // A template is listed in its creator's name and pays them, so only the
  // note's author may publish it, and only while still an editor of its
  // workspace: a teammate's note is not theirs to sell.
  const found = await loadMemberDocument<{ markdown: string; source_template_id: string | null }>(admin, {
    userId: user.id,
    docId: noteId,
    columns: "markdown, source_template_id",
    minRole: "editor",
  });
  if (!found.ok || found.doc.user_id !== user.id) return fail("That note isn't in your vault.", 404);
  const note = found.doc;

  const body = templateBodyFromNote(note.markdown ?? "");
  if (!body.trim()) return fail("This note is empty. Write something before publishing it.", 400);
  if (body.length > MAX_TEMPLATE_BODY) return fail("This note is too long to publish as a template.", 413);

  // Only a parent that exists on-chain: the contract refuses any other.
  let parent: { id: string; title: string; creatorWallet: string } | null = null;
  if (note.source_template_id) {
    const { data } = await admin
      .from("market_templates")
      .select("id, title, status, creator_wallet")
      .eq("id", note.source_template_id)
      .eq("network", NETWORK)
      .maybeSingle();
    if (data && data.status !== "pending") parent = { id: data.id, title: data.title, creatorWallet: data.creator_wallet };
  }

  // A sale pays everyone in one transaction, so it fails as a whole if anyone
  // can't receive the token (a G account without a USDC trustline).
  if (price > BigInt(0)) {
    try {
      if (!(await canReceive(wallet, token.contract))) {
        return fail(`Your wallet can't receive ${token.code} yet. Add a ${token.code} trustline, or price it in XLM.`, 409);
      }
      if (parent && !(await canReceive(parent.creatorWallet, token.contract))) {
        return fail(`The original template's creator can't receive ${token.code}, so this one has to be priced in XLM.`, 409);
      }
    } catch {
      return fail("The ledger couldn't be reached. Try again in a moment.", 503);
    }
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
    parent: parent && { id: parent.id, title: parent.title },
    wallet,
  });
}
