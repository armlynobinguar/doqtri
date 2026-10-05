import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { DoqtriRegistry } from "@/lib/stellar/contract-client";

export const runtime = "nodejs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Scoped by user_id: the service role would otherwise reach anyone's note.
  const { data: note, error: lookupError } = await admin
    .from("documents")
    .select("id, title")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 });
  }
  if (!note) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
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
    .eq("document_id", id)
    .eq("user_id", user.id);

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
      .eq("document_id", id)
      .eq("user_id", user.id);
    if (ingestsError) {
      return NextResponse.json({ error: ingestsError.message }, { status: 500 });
    }
  }

  const { error: deleteError } = await admin
    .from("documents")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({
    id,
    title: note.title,
    purgedUploads: paths.length,
  });
}
