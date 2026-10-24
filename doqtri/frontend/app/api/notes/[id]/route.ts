import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { DoqtriRegistry } from "@/lib/stellar/contract-client";
import {
  EDITING_ELSEWHERE,
  editingMessage,
  lockErrorAnswer,
  parseDocLockStatus,
  parseEditSession,
} from "@/lib/doc-lock";
import { liveLockHolder } from "@/lib/doc-lock-server";
import { isTitleTaken, MAX_TITLE_LENGTH } from "@/lib/title";
import {
  loadMemberDocument,
  UNIQUE_VIOLATION,
  workspaceTitles,
  type MemberDocumentRefusal,
} from "@/lib/workspace-docs";

export const runtime = "nodejs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The response for a note the caller cannot change. */
function refusal(result: MemberDocumentRefusal) {
  if (result.reason === "error") {
    return NextResponse.json({ error: result.message }, { status: 500 });
  }
  if (result.reason === "forbidden") {
    return NextResponse.json(
      { error: "You can read this note but not change it.", code: "READ_ONLY" },
      { status: 403 },
    );
  }
  return NextResponse.json({ error: "Note not found" }, { status: 404 });
}

/**
 * Refuses a change to a note while someone other than the caller holds its
 * edit lock (D-17): they are typing into it and would not see the change.
 * The caller's own lock does not stop them. Null when the change may go on.
 */
async function refuseIfLockedByOther(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  docId: string,
  userId: string,
) {
  const { holder, error } = await liveLockHolder(admin, docId);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (holder && holder !== userId) {
    return NextResponse.json(
      {
        error: `${editingMessage(null)}. Try again when they are done.`,
        code: "LOCKED",
      },
      { status: 423 },
    );
  }
  return null;
}

/**
 * Saves a note's text (WP-1.6, D-17). Body: `{ markdown, version, session }`,
 * where `version` is the save version the caller's copy is based on and
 * `session` the editor's edit session (lib/doc-lock.ts). Answers
 * `{ id, version }` with the new version.
 *
 * Runs on the session client: save_document() checks, as the caller, that
 * they are an editor or above, that they hold a live edit lock from this
 * session, not another tab (else 423
 * NOT_LOCK_HOLDER, with the lock's status so the editor can name the
 * holder), and that nobody saved since their copy was loaded (else 409
 * STALE_VERSION, with the current version). Nothing is written unless all
 * three hold, so no save overwrites another.
 */
export async function PUT(
  request: Request,
  context: RouteContext<"/api/notes/[id]">,
) {
  const { id } = await context.params;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  if (!UUID.test(id)) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  let markdown: string | null = null;
  let version: number | null = null;
  let editSession: string | null = null;
  try {
    const body = (await request.json()) as { markdown?: unknown; version?: unknown; session?: unknown };
    if (typeof body.markdown === "string") markdown = body.markdown;
    editSession = parseEditSession(body.session);
    if (typeof body.version === "number" && Number.isSafeInteger(body.version) && body.version >= 1) {
      version = body.version;
    }
  } catch {
    // falls through to the refusal below
  }

  if (markdown === null || version === null || editSession === null) {
    return NextResponse.json(
      { error: "A save needs the note's markdown, the version it is based on and the editor's session" },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("save_document", {
    p_document_id: id,
    p_markdown: markdown,
    p_base_version: version,
    p_session: editSession,
  });

  if (error) {
    const answer = lockErrorAnswer(error);
    const body: Record<string, unknown> = { error: answer.error, code: answer.code };
    if (answer.code === "STALE_VERSION") {
      const current = Number(error.details);
      if (Number.isSafeInteger(current)) body.version = current;
    }
    if (answer.code === "NOT_LOCK_HOLDER") {
      const { data: status } = await supabase.rpc("doc_lock_status_for", {
        p_document_id: id,
        p_session: editSession,
      });
      const lock = parseDocLockStatus(status);
      if (lock) {
        body.lock = lock;
        if (lock.mineElsewhere) body.error = `${EDITING_ELSEWHERE}, so this copy was not saved.`;
        else if (lock.holder && !lock.mine) body.error = editingMessage(lock.holderName);
      }
    }
    return NextResponse.json(body, { status: answer.status });
  }

  const saved = typeof data === "number" ? data : Number(data);
  if (!Number.isSafeInteger(saved)) {
    return NextResponse.json({ error: "Unexpected save result" }, { status: 500 });
  }
  return NextResponse.json({ id, version: saved });
}

/**
 * Renames a note. Only the `title` column changes: the markdown is left alone,
 * so an anchored note's content hash still matches the ledger and stays
 * renameable. Titles are the graph's join key, so a clash with another note
 * in the same workspace is refused rather than silently suffixed — the user
 * picked this name and should see that it did not stick. Editors and above
 * of the note's workspace may rename it.
 *
 * Refused with 423 while someone else holds the note's edit lock (D-17).
 *
 * Other notes' [[wikilinks]] to the old title are not rewritten. Editing their
 * markdown would un-anchor any of them that are on the ledger.
 */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/notes/[id]">,
) {
  const { id } = await context.params;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  if (!UUID.test(id)) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  let title = "";
  try {
    const body = (await request.json()) as { title?: unknown };
    if (typeof body.title === "string") title = body.title.trim();
  } catch {
    // falls through to the empty-title refusal
  }

  if (!title) {
    return NextResponse.json({ error: "A note needs a title" }, { status: 400 });
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      { error: `Titles are at most ${MAX_TITLE_LENGTH} characters` },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();

  // The service role skips RLS, so the workspace role is checked here.
  const found = await loadMemberDocument<{ title: string }>(admin, {
    userId: user.id,
    docId: id,
    columns: "title",
    minRole: "editor",
  });
  if (!found.ok) return refusal(found);
  const note = found.doc;

  const locked = await refuseIfLockedByOther(admin, id, user.id);
  if (locked) return locked;

  const { titles: others, error: titlesError } = await workspaceTitles(admin, note.workspace_id, {
    excludeId: id,
  });
  if (titlesError) {
    return NextResponse.json({ error: titlesError }, { status: 500 });
  }

  const taken = () =>
    NextResponse.json(
      { error: `Another note is already called “${title}”`, code: "TITLE_TAKEN" },
      { status: 409 },
    );
  if (isTitleTaken(title, others)) return taken();

  if (title !== note.title) {
    const { error: updateError } = await admin
      .from("documents")
      .update({ title })
      .eq("id", id)
      .eq("workspace_id", note.workspace_id);

    // A teammate took the title between the check and the write.
    if (updateError?.code === UNIQUE_VIOLATION) return taken();
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ id, title, previousTitle: note.title });
}

/**
 * Hard-deletes a note: the row (markdown and stored mindmap with it), its
 * ingest attempts, and the originals those attempts archived in the private
 * `uploads` bucket. Nothing here is recoverable.
 *
 * An anchored note cannot be deleted. The registry contract has no delete, so
 * the ledger entry would outlive the row and /d/[docId] would keep serving a
 * proof for a note that no longer exists — and a note whose heading labels had
 * silently vanished from that page. The explorer greys those notes out; this
 * check is what actually enforces it, including when the ledger moved after
 * the explorer last looked.
 *
 * Editors and above of the note's workspace may delete it; its ingest
 * attempts go with it whoever uploaded them. Not while someone else holds
 * its edit lock (D-17): 423, as for a rename.
 *
 * The uploads are purged before the row is deleted: a Storage failure leaves
 * the note intact and the delete retryable, rather than orphaning private
 * files that nothing points at any more.
 */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/notes/[id]">,
) {
  const { id } = await context.params;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  if (!UUID.test(id)) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();

  // The service role skips RLS, so the workspace role is checked here.
  const found = await loadMemberDocument<{ title: string }>(admin, {
    userId: user.id,
    docId: id,
    columns: "title",
    minRole: "editor",
  });
  if (!found.ok) return refusal(found);
  const note = found.doc;

  const locked = await refuseIfLockedByOther(admin, id, user.id);
  if (locked) return locked;

  // Strict read: it tells "not anchored" apart from "the ledger is down", and
  // only the first of those may proceed.
  let anchored: boolean;
  try {
    anchored = (await DoqtriRegistry.readDocument(id)) !== null;
  } catch {
    return NextResponse.json(
      {
        error:
          "Could not reach Stellar to check whether this note is anchored. Try again.",
        code: "CHAIN_UNREACHABLE",
      },
      { status: 503 },
    );
  }

  if (anchored) {
    return NextResponse.json(
      {
        error:
          "This note is anchored on Stellar. The on-chain record cannot be deleted, so the note is kept with it.",
        code: "ANCHORED",
      },
      { status: 409 },
    );
  }

  const { data: attempts, error: attemptsError } = await admin
    .from("ingests")
    .select("id, object_path")
    .eq("document_id", id);

  if (attemptsError) {
    return NextResponse.json({ error: attemptsError.message }, { status: 500 });
  }

  const paths = (attempts ?? [])
    .map((row: { object_path: string | null }) => row.object_path)
    .filter((path: string | null): path is string => Boolean(path));

  if (paths.length > 0) {
    const { error: storageError } = await admin.storage
      .from("uploads")
      .remove(paths);
    if (storageError) {
      return NextResponse.json(
        {
          error: `Could not delete the archived originals: ${storageError.message}. The note was kept.`,
        },
        { status: 500 },
      );
    }
  }

  if ((attempts ?? []).length > 0) {
    const { error: ingestsError } = await admin
      .from("ingests")
      .delete()
      .eq("document_id", id);
    if (ingestsError) {
      return NextResponse.json({ error: ingestsError.message }, { status: 500 });
    }
  }

  const { error: deleteError } = await admin
    .from("documents")
    .delete()
    .eq("id", id)
    .eq("workspace_id", note.workspace_id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({
    id,
    title: note.title,
    purgedUploads: paths.length,
  });
}
