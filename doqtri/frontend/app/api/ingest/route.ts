import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { classifyUpload, markdownFromDocument } from "@/lib/openai";
import { generateAndStoreMindmap } from "@/lib/mindmap-store";
import { deriveTitle, uniqueTitle } from "@/lib/title";

// officeparser needs Node APIs, and PDF ingestion is not edge-friendly.
export const runtime = "nodejs";
export const maxDuration = 300;

/** Serverless request bodies are capped well below this; fail clearly first. */
const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(request: Request) {
  // 1. Establish who is calling. Everything below is stamped with this id.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let file: File;
  try {
    const form = await request.formData();
    const candidate = form.get("file");
    if (!(candidate instanceof File)) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }
    file = candidate;
  } catch {
    return NextResponse.json({ error: "Malformed upload" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "That file is larger than 20 MB" },
      { status: 413 },
    );
  }

  const kind = classifyUpload(file.name, file.type);
  if (!kind) {
    return NextResponse.json(
      { error: "Unsupported file type. Use PDF, DOCX, PPTX, or text." },
      { status: 415 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // 2. Convert to markdown before writing anything, so a failed conversion
  //    does not leave an orphaned row or object.
  let markdown: string;
  try {
    markdown = await markdownFromDocument({
      filename: file.name,
      mimeType: file.type,
      bytes,
      kind,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not convert that document";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (markdown.trim().length === 0) {
    return NextResponse.json(
      { error: "The conversion produced an empty note" },
      { status: 502 },
    );
  }

  // 3. Service role from here on: it bypasses RLS, so user.id must come from
  //    the verified session above and never from the request body.
  const admin = createSupabaseAdminClient();

  const { data: existing, error: titlesError } = await admin
    .from("documents")
    .select("title")
    .eq("user_id", user.id);

  if (titlesError) {
    return NextResponse.json({ error: titlesError.message }, { status: 500 });
  }

  const title = uniqueTitle(
    deriveTitle(markdown, file.name),
    (existing ?? []).map((row: { title: string }) => row.title),
  );

  // Keep the original for reference. A failure here should not lose the
  // markdown, which is what the app actually reads.
  const objectPath = `${user.id}/${crypto.randomUUID()}-${file.name}`;
  const { error: storageError } = await admin.storage
    .from("uploads")
    .upload(objectPath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

  if (storageError) {
    console.warn(`[ingest] original not archived: ${storageError.message}`);
  }

  const { data: inserted, error: insertError } = await admin
    .from("documents")
    .insert({ user_id: user.id, title, markdown })
    .select("id")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // 4. Build the document mindmap inline, so it exists the moment the note
  //    opens and no pending state is needed anywhere in the UI. Best-effort:
  //    the note is already saved, and a missing mindmap falls back to the
  //    heading tree and can be rebuilt from the mindmap view.
  let mindmapped = true;
  try {
    await generateAndStoreMindmap(admin, {
      id: inserted.id,
      userId: user.id,
      title,
      markdown,
    });
  } catch (error) {
    mindmapped = false;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ingest] mindmap not generated for ${inserted.id}: ${message}`);
  }

  return NextResponse.json({ id: inserted.id, title, mindmapped });
}
