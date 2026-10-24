import { NextResponse, after } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import {
  MINDMAP_PROMO,
  PROMO_BUCKET,
  promoPathsInFolder,
  promoUploadFolder,
} from "@/lib/promo";
import { consumeAiQuota } from "@/lib/ai-quota";
import { rateAndStoreSubmission } from "@/lib/promo-rating-ai";

export const runtime = "nodejs";
// The AI rating runs in after(), inside this function's lifetime.
export const maxDuration = 120;

/**
 * Step 2 of a promo entry: record the screenshots uploaded through the URLs
 * from /api/promo/uploads. One entry per user; submitting again replaces it.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!MINDMAP_PROMO.active) {
    return NextResponse.json({ error: "This promo has ended." }, { status: 410 });
  }

  let body: { uploadId?: unknown; paths?: unknown; caption?: unknown; contact?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const names = promoPathsInFolder(body.paths, user.id, body.uploadId);
  if (!names) {
    return NextResponse.json({ error: "Invalid screenshots." }, { status: 400 });
  }
  const caption = typeof body.caption === "string" ? body.caption.trim() : "";
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  if (caption.length > MINDMAP_PROMO.maxCaption || contact.length > MINDMAP_PROMO.maxContact) {
    return NextResponse.json({ error: "Caption or contact is too long." }, { status: 400 });
  }

  // Service role from here on: user.id comes from the verified session above.
  const admin = createSupabaseAdminClient();
  const folder = promoUploadFolder(user.id, body.uploadId as string);

  // A signed URL being minted is not proof of an upload; the files must exist.
  const { data: listed, error: listError } = await admin.storage
    .from(PROMO_BUCKET)
    .list(folder);
  if (listError) {
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }
  const present = new Set((listed ?? []).map((file) => file.name));
  if (!names.every((name) => present.has(name))) {
    return NextResponse.json(
      { error: "Some screenshots did not finish uploading. Try again." },
      { status: 400 },
    );
  }

  const { data: previous } = await admin
    .from("promo_submissions")
    .select("image_paths")
    .eq("user_id", user.id)
    .eq("promo", MINDMAP_PROMO.id)
    .maybeSingle();

  const imagePaths = names.map((name) => `${folder}/${name}`);
  const { data: saved, error: upsertError } = await admin
    .from("promo_submissions")
    .upsert(
      {
        user_id: user.id,
        promo: MINDMAP_PROMO.id,
        image_paths: imagePaths,
        caption,
        contact,
        updated_at: new Date().toISOString(),
        // New screenshots need a fresh review.
        status: "pending",
        reviewed_at: null,
        ai_score: null,
        ai_rating: null,
        ai_rated_at: null,
        ai_rating_error: null,
      },
      { onConflict: "user_id,promo" },
    )
    .select("id")
    .single();
  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  // Best effort: the entry already points at the new screenshots.
  const replaced = ((previous?.image_paths as string[] | undefined) ?? []).filter(
    (path) => !imagePaths.includes(path),
  );
  if (replaced.length) await admin.storage.from(PROMO_BUCKET).remove(replaced);

  // Rate after responding, so the entrant is not kept waiting on the model.
  // Charged to the entrant's AI budget, which bounds resubmit loops; an entry
  // over budget or whose rating fails stays unrated for an admin to rate.
  after(async () => {
    const quota = await consumeAiQuota(admin, user.id, "promo-rating");
    if (!quota.ok) {
      await admin
        .from("promo_submissions")
        .update({
          ai_rating_error:
            quota.reason === "exceeded"
              ? "Not rated: the entrant's daily AI limit was used up."
              : "Not rated: the AI budget could not be checked.",
        })
        .eq("id", saved.id);
      return;
    }
    try {
      await rateAndStoreSubmission(admin, saved.id as string);
    } catch (error) {
      console.error(`[promo-rating] ${saved.id}: ${error instanceof Error ? error.message : error}`);
    }
  });

  return NextResponse.json({ ok: true });
}
