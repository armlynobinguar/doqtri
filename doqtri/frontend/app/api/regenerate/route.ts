import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { improveMarkdown } from "@/lib/openai";
import { consumeAiQuota, quotaRefusal } from "@/lib/ai-quota";
import { generateAndStoreMindmap } from "@/lib/mindmap-store";
import { loadMemberDocument, workspaceTitles } from "@/lib/workspace-docs";
import { lockErrorAnswer } from "@/lib/doc-lock";
import { liveLockHolder } from "@/lib/doc-lock-server";

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

  // The service role ignores RLS, so the workspace role is enforced here:
  // this writes the note, so editors and above only.
  const found = await loadMemberDocument<{ title: string; markdown: string; version: number }>(admin, {
    userId: user.id,
    docId: id,
    columns: "title, markdown, version",
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

  // Regenerating rewrites the note, so it is an edit like any other (D-17):
  // only whoever holds the edit lock may do it. Checked before the quota is
  // charged and the model called; save_document() checks again at the end.
  const { holder, error: lockError } = await liveLockHolder(admin, id);
  if (lockError) {
    return NextResponse.json({ error: lockError }, { status: 500 });
  }
  if (holder !== user.id) {
    return NextResponse.json(
      {
        error: holder
          ? "Someone else is editing this note, so it cannot be regenerated now."
          : "Start editing the note before regenerating it.",
        code: "NOT_LOCK_HOLDER",
      },
      { status: 423 },
    );
  }

  // Charged after the ownership check, so a bad id costs nothing.
  const quota = await consumeAiQuota(admin, user.id, "regenerate");
  if (!quota.ok) return quotaRefusal(quota);

  // Give the model the workspace's real note titles so it links to notes
  // that exist rather than inventing ghost targets.
  const { titles: others, error: titlesError } = await workspaceTitles(admin, doc.workspace_id, {
    excludeId: id,
  });

  if (titlesError) {
    return NextResponse.json({ error: titlesError }, { status: 500 });
  }

  let markdown: string;
  try {
    markdown = await improveMarkdown({
      markdown: doc.markdown,
      titles: others,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not regenerate that note";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // v1 regenerate is a full overwrite; the client has already confirmed.
  // Saved as the user, on the version the model was given: if the note was
  // saved meanwhile, or the lock was lost to a takeover, nothing is written.
  const { data: version, error: saveError } = await supabase.rpc("save_document", {
    p_document_id: id,
    p_markdown: markdown,
    p_base_version: doc.version,
  });

  if (saveError) {
    const answer = lockErrorAnswer(saveError);
    return NextResponse.json({ error: answer.error, code: answer.code }, { status: answer.status });
  }

  // The markdown just changed underneath the stored mindmap, so rebuild it
  // rather than leave the note reporting itself stale the moment it reloads.
  // Best-effort, as at ingest: the note itself is already saved.
  try {
    await generateAndStoreMindmap(admin, {
      id: doc.id,
      workspaceId: doc.workspace_id,
      title: doc.title,
      markdown,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[regenerate] mindmap not rebuilt for ${doc.id}: ${message}`);
  }

  return NextResponse.json({ markdown, version: Number(version) });
}
