import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { consumeAiQuota, quotaRefusal } from "@/lib/ai-quota";
import { generateAndStoreMindmap } from "@/lib/mindmap-store";
import { loadMemberDocument } from "@/lib/workspace-docs";

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

  // The service role ignores RLS, so the workspace role is enforced here:
  // this writes the note, so editors and above only.
  const found = await loadMemberDocument<{ title: string; markdown: string }>(admin, {
    userId: user.id,
    docId: id,
    columns: "title, markdown",
    minRole: "editor",
  });
  if (!found.ok) {
    if (found.reason === "error") {
      return NextResponse.json({ error: found.message }, { status: 500 });
    }
    if (found.reason === "forbidden") {
      return NextResponse.json({ error: "You can read this note but not change it." }, { status: 403 });
    }
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }
  const doc = found.doc;

  // Charged after the ownership check, so a bad id costs nothing.
  const quota = await consumeAiQuota(admin, user.id, "mindmap");
  if (!quota.ok) return quotaRefusal(quota);

  try {
    const mindmap = await generateAndStoreMindmap(admin, {
      id: doc.id,
      workspaceId: doc.workspace_id,
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
