import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { DoqtriRegistry } from "@/lib/stellar/contract-client";
import {
  EDITING_ELSEWHERE,
  editingMessage,
  LOCK_NOT_HELD,
  lockErrorAnswer,
  parseDocLockStatus,
  parseEditSession,
  STALE_VERSION,
} from "@/lib/doc-lock";
import { liveLockHolder } from "@/lib/doc-lock-server";
import { afterNoteSaved, noteBeforeSave } from "@/lib/integrations/qdit-save-hook";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { hasControlCharacters, isTitleTaken, MAX_TITLE_LENGTH, TITLE_ONE_LINE } from "@/lib/title";
import { rewriteTitleHeading } from "@/lib/title-heading";
import {
  loadMemberDocument,
  UNIQUE_VIOLATION,
  workspaceTitles,
  type MemberDocumentRefusal,
} from "@/lib/workspace-docs";

export const runtime = "nodejs";

/** Postgres check_violation: rename_document() refusing a title that is not one line. */
const CHECK_VIOLATION = "23514";

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

  // With the qdit integration on, the text being replaced, so the save can
  // work out which linked headings moved (WP-2.5). Null otherwise.
  const before = await noteBeforeSave(supabase, id);

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
  await afterNoteSaved({ userId: user.id, docId: id, baseVersion: version, savedVersion: saved, markdown, before });
  return NextResponse.json({ id, version: saved });
}

/** Saves that may land between a rename's read and its write before it gives up. */
const RENAME_ATTEMPTS = 3;

type RenameRow = { title: string; markdown: string; version: number };

/** A rename rename_document() refused on the edit lock (DQLCK), as HTTP. */
function renameLockRefusal(error: { details?: string | null }) {
  if (error.details === "elsewhere") {
    return NextResponse.json(
      { error: `${EDITING_ELSEWHERE}, so it cannot be renamed here.`, code: "NOT_LOCK_HOLDER" },
      { status: 423 },
    );
  }
  return NextResponse.json(
    { error: `${editingMessage(null)}. Try again when they are done.`, code: "LOCKED" },
    { status: 423 },
  );
}

/**
 * Renames a note. Titles are the graph's join key, so a clash with another
 * note in the same workspace is refused rather than silently suffixed — the
 * user picked this name and should see that it did not stick. Editors and
 * above of the note's workspace may rename it. Body: `{ title, session? }`,
 * where `session` is the edit session of the editor the rename comes from,
 * when the note is open in it (lib/doc-lock.ts). A title is one line: line
 * breaks and other control characters are refused (400).
 *
 * The note's own title heading follows the title (DOQ-35): when the first
 * non-blank line is `# <old title>` (lib/title-heading.ts), it becomes
 * `# <new title>` and nothing else in the text changes. Otherwise the user
 * wrote their own heading, and the markdown is left alone.
 *
 * The write is rename_document() (20261109100000_rename_document.sql), called
 * as the user, as save_document() is for a save. In one step it checks the
 * caller's role, the note's edit lock and the version this route read the
 * text at, and writes the title and the rewritten text in one UPDATE, so a
 * refusal or a title clash changes neither. Its lock rule (D-17):
 *   - another user holds the lock: refused, 423 LOCKED
 *   - the caller holds it from another session (another tab, or none, as
 *     from the explorer) and the heading would change: refused, 423
 *     NOT_LOCK_HOLDER, since that tab's next save would otherwise stop on a
 *     conflict. A title-only rename goes on there, as it always did.
 *   - free, or held by the caller from `session`: goes on
 * A save landing between this route's read and the call (DQVER) makes it
 * read again and redo the rewrite, a few times before answering 409.
 *
 * A heading that changes is an edit like any other: documents_before_save
 * bumps the version, afterNoteSaved() runs exactly as after a PUT (the
 * link remap, and the rest of that hook), a stored concept map reads as
 * stale (its hash no longer matches), and an anchored note shows as changed
 * since it was anchored until it is anchored again. The answer then also
 * carries the new `markdown` and `version`, and the `previousVersion` they
 * replace, for an open editor to adopt as its saved copy.
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
  let editSession: string | null = null;
  try {
    const body = (await request.json()) as { title?: unknown; session?: unknown };
    if (typeof body.title === "string") title = body.title.trim();
    if (body.session !== undefined && body.session !== null) {
      editSession = parseEditSession(body.session);
      if (!editSession) {
        return NextResponse.json(
          { error: "This editor has no edit session. Reload the note.", code: "BAD_SESSION" },
          { status: 400 },
        );
      }
    }
  } catch {
    // falls through to the empty-title refusal
  }

  if (!title) {
    return NextResponse.json({ error: "A note needs a title" }, { status: 400 });
  }
  if (hasControlCharacters(title)) {
    return NextResponse.json({ error: TITLE_ONE_LINE, code: "BAD_TITLE" }, { status: 400 });
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      { error: `Titles are at most ${MAX_TITLE_LENGTH} characters` },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();

  // The service role skips RLS, so the workspace role is checked here, for a
  // clear answer before anything is written; rename_document() checks again.
  const load = () =>
    loadMemberDocument<RenameRow>(admin, {
      userId: user.id,
      docId: id,
      columns: "title, markdown, version",
      minRole: "editor",
    });
  const found = await load();
  if (!found.ok) return refusal(found);
  let note = found.doc;

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

  if (title === note.title) {
    return NextResponse.json({ id, title, previousTitle: note.title });
  }

  for (let attempt = 1; ; attempt++) {
    const baseVersion = Number(note.version);
    const markdown = rewriteTitleHeading(note.markdown, note.title, title);

    const { data, error } = await supabase.rpc("rename_document", {
      p_document_id: id,
      p_title: title,
      p_markdown: markdown,
      p_base_version: baseVersion,
      p_session: editSession,
    });

    if (error) {
      // A teammate took the title between the check and the write.
      if (error.code === UNIQUE_VIOLATION) return taken();
      if (error.code === LOCK_NOT_HELD) return renameLockRefusal(error);
      if (error.code === CHECK_VIOLATION) {
        return NextResponse.json({ error: TITLE_ONE_LINE, code: "BAD_TITLE" }, { status: 400 });
      }
      if (error.code !== STALE_VERSION) {
        const answer = lockErrorAnswer(error);
        return NextResponse.json({ error: answer.error, code: answer.code }, { status: answer.status });
      }
      // Saved since it was read: nothing was written. Start again from the
      // newer text, unless the saves keep coming.
      if (attempt >= RENAME_ATTEMPTS) {
        return NextResponse.json(
          { error: "This note was saved while it was being renamed. Try again.", code: "STALE_VERSION" },
          { status: 409 },
        );
      }
      const again = await load();
      if (!again.ok) return refusal(again);
      note = again.doc;
      if (title === note.title) {
        return NextResponse.json({ id, title, previousTitle: note.title });
      }
      continue;
    }

    const version = typeof data === "number" ? data : Number(data);
    if (!Number.isSafeInteger(version)) {
      return NextResponse.json({ error: "Unexpected rename result" }, { status: 500 });
    }
    if (markdown === null) {
      return NextResponse.json({ id, title, previousTitle: note.title });
    }
    await afterNoteSaved({
      userId: user.id,
      docId: id,
      baseVersion,
      savedVersion: version,
      markdown,
      before: { title: note.title, markdown: note.markdown, version: baseVersion },
      title,
    });
    return NextResponse.json({
      id,
      title,
      previousTitle: note.title,
      markdown,
      version,
      previousVersion: baseVersion,
    });
  }
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

  // A note linked to a qdit project is kept until an admin unlinks it
  // (D-10): deleting it here would leave qdit's links pointing at nothing,
  // with no way left to remove them (WP-2.5). The database refuses it too
  // (20261025110000_qdit_linking.sql); this says why first. No row exists
  // unless the qdit integration was used.
  const { data: qditProject, error: qditProjectError } = await admin
    .from("doc_project_links")
    .select("project_name")
    .eq("document_id", id)
    .maybeSingle();
  if (qditProjectError) {
    return NextResponse.json({ error: qditProjectError.message }, { status: 500 });
  }
  if (qditProject) {
    const name = (qditProject as { project_name: string }).project_name;
    // With the integration off the ship panel shows no qdit section, so
    // there is nothing to point the user at (an operator turns it back on).
    return NextResponse.json(
      {
        error: qditIntegrationEnabled()
          ? `This note is linked to the qdit project ${name}. A workspace admin must unlink it in the ship panel first, so qdit drops its links too (or forget the link there, if qdit no longer has the project).`
          : `This note is linked to the qdit project ${name}, and the qdit integration is turned off on this site, so the link can't be removed for now. The note is kept until it is.`,
        code: "QDIT_LINKED",
      },
      { status: 409 },
    );
  }

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
    // 23001: linked to qdit since the check above (the database's guard).
    if (deleteError.code === "23001") {
      return NextResponse.json(
        {
          error: "This note was just linked to a qdit project. A workspace admin must unlink it first.",
          code: "QDIT_LINKED",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({
    id,
    title: note.title,
    purgedUploads: paths.length,
  });
}
