import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import {
  MINDMAP_PROMO,
  PROMO_BUCKET,
  PROMO_IMAGE_TYPES,
  promoFilesProblem,
  promoUploadFolder,
  type PromoFileSpec,
} from "@/lib/promo";

/**
 * Step 1 of a promo entry: mint one signed upload URL per screenshot.
 *
 * The browser uploads straight to storage, so screenshots never pass through
 * this function and its request body limit. The URLs only reach the caller's
 * own folder, and the bucket enforces the size and type limits on upload.
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

  let files: PromoFileSpec[];
  try {
    const body = (await request.json()) as { files?: unknown };
    if (!Array.isArray(body.files)) throw new Error();
    files = body.files.map((file: { type?: unknown; size?: unknown }) => ({
      type: typeof file?.type === "string" ? file.type : "",
      size: typeof file?.size === "number" ? file.size : 0,
    }));
  } catch {
    return NextResponse.json({ error: "Expected a list of files." }, { status: 400 });
  }

  const problem = promoFilesProblem(files);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  // Service role: user.id comes from the verified session above.
  const admin = createSupabaseAdminClient();
  const uploadId = crypto.randomUUID();
  const folder = promoUploadFolder(user.id, uploadId);

  const uploads: { path: string; token: string }[] = [];
  for (const [i, file] of files.entries()) {
    const path = `${folder}/${i}.${PROMO_IMAGE_TYPES[file.type]}`;
    const { data, error } = await admin.storage
      .from(PROMO_BUCKET)
      .createSignedUploadUrl(path);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    uploads.push({ path: data.path, token: data.token });
  }

  return NextResponse.json({ uploadId, uploads });
}
