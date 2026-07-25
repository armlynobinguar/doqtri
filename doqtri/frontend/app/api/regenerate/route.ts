import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { improveMarkdown } from "@/lib/openai";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let id: string;
  try {
    const body: unknown = await request.json();
    const candidate =
      body && typeof body === "object" && "id" in body
        ? (body as { id: unknown }).id
        : null;
    if (typeof candidate !== "string" || candidate.length === 0) {
      return NextResponse.json({ error: "Missing document id" }, { status: 400 });
    }
    id = candidate;
  } catch {
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();

  // Scoped by user_id as well as id: the service role ignores RLS, so
  // ownership has to be enforced here.
  const { data: doc, error: loadError } = await admin
    .from("documents")
    .select("id, title, markdown")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }
  if (!doc) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  // Give the model the user's real note titles so it links to notes that
  // exist rather than inventing ghost targets.
  const { data: others, error: titlesError } = await admin
    .from("documents")
    .select("title")
    .eq("user_id", user.id)
    .neq("id", id);

  if (titlesError) {
    return NextResponse.json({ error: titlesError.message }, { status: 500 });
  }

  let markdown: string;
  try {
    markdown = await improveMarkdown({
      markdown: doc.markdown,
      titles: (others ?? []).map((row: { title: string }) => row.title),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not regenerate that note";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // v1 regenerate is a full overwrite; the client has already confirmed.
  const { error: updateError } = await admin
    .from("documents")
    .update({ markdown, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ markdown });
}
