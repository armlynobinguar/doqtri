import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  EDITING_ELSEWHERE,
  editingMessage,
  lockErrorAnswer,
  parseDocLockStatus,
  parseEditSession,
} from "@/lib/doc-lock";

export const runtime = "nodejs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A note's edit lock (WP-1.6, D-17).
 *
 *   GET                    who holds it, as the caller sees it
 *   POST                   take it, or renew it when the caller holds it
 *   POST ?takeover=1       take it from whoever holds it (admins and owners;
 *                          anyone who can edit, for their own lock in
 *                          another tab)
 *   DELETE                 release it
 *
 * Every call names the editor's edit session as `?session=<uuid>`: the lock
 * is held by one user from one tab (lib/doc-lock.ts). POST and DELETE need
 * it; a GET without one sees the caller's own lock as held elsewhere.
 *
 * Every call runs on the session client, so the database functions see the
 * caller as auth.uid() and check their role themselves; nothing here uses the
 * service role. A POST that finds someone else holding the lock answers 423
 * with the status, so the editor can name them and go read-only.
 */

type Resolved =
  | {
      ok: true;
      supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
      id: string;
      session: string | null;
    }
  | { ok: false; response: NextResponse };

async function resolve(
  request: Request,
  context: RouteContext<"/api/notes/[id]/lock">,
  { needSession }: { needSession: boolean },
): Promise<Resolved> {
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
  const raw = new URL(request.url).searchParams.get("session");
  const session = parseEditSession(raw);
  if ((raw !== null || needSession) && !session) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "A lock request names the editor's session as a uuid", code: "BAD_SESSION" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, supabase, id, session };
}

function dbError(error: { code?: string | null; message?: string | null }) {
  const answer = lockErrorAnswer(error);
  return NextResponse.json({ error: answer.error, code: answer.code }, { status: answer.status });
}

function badStatus() {
  return NextResponse.json({ error: "Unexpected lock status from the database" }, { status: 500 });
}

export async function GET(request: Request, context: RouteContext<"/api/notes/[id]/lock">) {
  const resolved = await resolve(request, context, { needSession: false });
  if (!resolved.ok) return resolved.response;

  const { data, error } = await resolved.supabase.rpc("doc_lock_status_for", {
    p_document_id: resolved.id,
    p_session: resolved.session,
  });
  if (error) return dbError(error);
  const lock = parseDocLockStatus(data);
  if (!lock) return badStatus();
  return NextResponse.json({ lock });
}

export async function POST(request: Request, context: RouteContext<"/api/notes/[id]/lock">) {
  const resolved = await resolve(request, context, { needSession: true });
  if (!resolved.ok) return resolved.response;

  const takeover = new URL(request.url).searchParams.get("takeover") === "1";
  const { data, error } = await resolved.supabase.rpc("take_doc_lock", {
    p_document_id: resolved.id,
    p_session: resolved.session,
    p_takeover: takeover,
  });
  if (error) return dbError(error);
  const lock = parseDocLockStatus(data);
  if (!lock) return badStatus();

  if (!lock.mine) {
    return NextResponse.json(
      {
        error: lock.mineElsewhere ? EDITING_ELSEWHERE : editingMessage(lock.holderName),
        code: lock.mineElsewhere ? "LOCKED_ELSEWHERE" : "LOCKED",
        lock,
      },
      { status: 423 },
    );
  }
  return NextResponse.json({ lock });
}

export async function DELETE(request: Request, context: RouteContext<"/api/notes/[id]/lock">) {
  const resolved = await resolve(request, context, { needSession: true });
  if (!resolved.ok) return resolved.response;

  const { data, error } = await resolved.supabase.rpc("release_doc_lock", {
    p_document_id: resolved.id,
    p_session: resolved.session,
  });
  if (error) return dbError(error);
  return NextResponse.json({ released: data === true });
}
