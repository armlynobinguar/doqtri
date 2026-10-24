import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { editingMessage, lockErrorAnswer, parseDocLockStatus } from "@/lib/doc-lock";

export const runtime = "nodejs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A note's edit lock (WP-1.6, D-17).
 *
 *   GET                    who holds it, as the caller sees it
 *   POST                   take it, or renew it when the caller holds it
 *   POST ?takeover=1       take it from whoever holds it (admins and owners)
 *   DELETE                 release it
 *
 * Every call runs on the session client, so the database functions see the
 * caller as auth.uid() and check their role themselves; nothing here uses the
 * service role. A POST that finds someone else holding the lock answers 423
 * with the status, so the editor can name them and go read-only.
 */

type Resolved =
  | { ok: true; supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>; id: string }
  | { ok: false; response: NextResponse };

async function resolve(context: RouteContext<"/api/notes/[id]/lock">): Promise<Resolved> {
  const { id } = await context.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }
  if (!UUID.test(id)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Note not found", code: "NOT_FOUND" }, { status: 404 }),
    };
  }
  return { ok: true, supabase, id };
}

function dbError(error: { code?: string | null; message?: string | null }) {
  const answer = lockErrorAnswer(error);
  return NextResponse.json({ error: answer.error, code: answer.code }, { status: answer.status });
}

function badStatus() {
  return NextResponse.json({ error: "Unexpected lock status from the database" }, { status: 500 });
}

export async function GET(_request: Request, context: RouteContext<"/api/notes/[id]/lock">) {
  const resolved = await resolve(context);
  if (!resolved.ok) return resolved.response;

  const { data, error } = await resolved.supabase.rpc("doc_lock_status_for", {
    p_document_id: resolved.id,
  });
  if (error) return dbError(error);
  const lock = parseDocLockStatus(data);
  if (!lock) return badStatus();
  return NextResponse.json({ lock });
}

export async function POST(request: Request, context: RouteContext<"/api/notes/[id]/lock">) {
  const resolved = await resolve(context);
  if (!resolved.ok) return resolved.response;

  const takeover = new URL(request.url).searchParams.get("takeover") === "1";
  const { data, error } = await resolved.supabase.rpc("take_doc_lock", {
    p_document_id: resolved.id,
    p_takeover: takeover,
  });
  if (error) return dbError(error);
  const lock = parseDocLockStatus(data);
  if (!lock) return badStatus();

  if (!lock.mine) {
    return NextResponse.json(
      { error: editingMessage(lock.holderName), code: "LOCKED", lock },
      { status: 423 },
    );
  }
  return NextResponse.json({ lock });
}

export async function DELETE(_request: Request, context: RouteContext<"/api/notes/[id]/lock">) {
  const resolved = await resolve(context);
  if (!resolved.ok) return resolved.response;

  const { data, error } = await resolved.supabase.rpc("release_doc_lock", {
    p_document_id: resolved.id,
  });
  if (error) return dbError(error);
  return NextResponse.json({ released: data === true });
}
