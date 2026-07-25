import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { generateAndStoreMindmap } from "@/lib/mindmap-store";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Rebuilds one document's mindmap from its current markdown.
 *
 * Two callers: the mindmap view, when a note has no stored map at all (rows
 * that predate the feature, or an ingest whose extraction failed), and the
 * explicit rebuild button, when the markdown has moved on since the map was
 * generated. Both are the same operation, so there is one route.
 */
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

  try {
    const mindmap = await generateAndStoreMindmap(admin, {
      id: doc.id,
      userId: user.id,
      title: doc.title,
      markdown: doc.markdown,
    });
    return NextResponse.json({ mindmap });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not build that mindmap";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
