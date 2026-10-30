import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { improveMarkdown } from "@/lib/openai";
import { consumeAiQuota, quotaRefusal } from "@/lib/ai-quota";
import { generateAndStoreMindmap } from "@/lib/mindmap-store";
import { afterNoteSaved } from "@/lib/integrations/qdit-save-hook";
import { loadMemberDocument, workspaceTitles } from "@/lib/workspace-docs";
import {
  EDITING_ELSEWHERE,
  lockErrorAnswer,
  parseDocLockStatus,
  parseEditSession,
} from "@/lib/doc-lock";

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
  let editSession: string | null;
  try {
    const body: unknown = await request.json();
    const fields = (body && typeof body === "object" ? body : {}) as { id?: unknown; session?: unknown };
    const candidate = fields.id;
    if (typeof candidate !== "string" || candidate.length === 0) {
      return NextResponse.json({ error: "Missing document id" }, { status: 400 });
    }
    id = candidate;
    // The editor's edit session: the lock is held by one tab (D-17).
    editSession = parseEditSession(fields.session);
    if (!editSession) {
      return NextResponse.json({ error: "Missing the editor's session", code: "BAD_SESSION" }, { status: 400 });
    }
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
  // only the editor session holding the lock may do it. The lock is renewed
  // here, as the user, before the quota is charged and the model called, so
  // it cannot lapse during the call (at most maxDuration, well under the ten
  // idle minutes). A lock that is free is taken, as an edit would; one held
  // by someone else, or by another tab, refuses. save_document() checks
  // again at the end, which only an admin takeover meanwhile can fail.
  const { data: lockRow, error: lockError } = await supabase.rpc("take_doc_lock", {
    p_document_id: id,
    p_session: editSession,
    p_takeover: false,
  });
  if (lockError) {
    const answer = lockErrorAnswer(lockError);
    return NextResponse.json({ error: answer.error, code: answer.code }, { status: answer.status });
  }
  const lock = parseDocLockStatus(lockRow);
  if (!lock) {
    return NextResponse.json({ error: "Unexpected lock status from the database" }, { status: 500 });
  }
  if (!lock.mine) {
    return NextResponse.json(
      {
        error: lock.mineElsewhere
          ? `${EDITING_ELSEWHERE}, so it cannot be regenerated here.`
          : "Someone else is editing this note, so it cannot be regenerated now.",
        code: "NOT_LOCK_HOLDER",
        lock,
      },
      { status: 423 },
    );
  }

  // Charged after the ownership and lock checks, so a bad id or a note
  // someone else is editing costs nothing.
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
    p_session: editSession,
  });

  if (saveError) {
    const answer = lockErrorAnswer(saveError);
    return NextResponse.json({ error: answer.error, code: answer.code }, { status: answer.status });
  }

  // Headings the model moved or renamed take their links along (WP-2.5).
  // The text it replaced is the one it was given, at doc.version.
  await afterNoteSaved({
    userId: user.id,
    docId: doc.id,
    baseVersion: doc.version,
    savedVersion: Number(version),
    markdown,
    before: { title: doc.title, markdown: doc.markdown, version: doc.version },
    title: doc.title,
  });

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
