import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { consumeAiQuota, quotaRefusal } from "@/lib/ai-quota";
import { classifyUpload } from "@/lib/openai";
import { INGEST_ERRORS, type IngestErrorCode } from "@/lib/ingest/errors";
import { ingestStream, runIngest } from "@/lib/ingest/pipeline";
import { readActiveWorkspaceCookie, workspaceForCreate } from "@/lib/active-workspace";

// officeparser and mammoth need Node APIs, and PDF ingestion is not edge-friendly.
export const runtime = "nodejs";
export const maxDuration = 300;

/** Serverless request bodies are capped well below this; fail clearly first. */
const MAX_BYTES = 20 * 1024 * 1024;

function reject(code: IngestErrorCode, status: number) {
  return NextResponse.json({ error: INGEST_ERRORS[code].message, code }, { status });
}

/**
 * Upload -> markdown note. Request problems (auth, size, type) are answered
 * with a JSON error; once the upload is accepted the response is an NDJSON
 * progress stream (see lib/ingest/events.ts) that always ends in a `result` or
 * a typed `error`.
 */
export async function POST(request: Request) {
  // 1. Establish who is calling. Everything below is stamped with this id.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return reject("NOT_SIGNED_IN", 401);

  let file: File;
  let requestedWorkspace: unknown;
  try {
    const form = await request.formData();
    requestedWorkspace = form.get("workspaceId");
    const candidate = form.get("file");
    if (!(candidate instanceof File)) return reject("NO_FILE", 400);
    file = candidate;
  } catch {
    return reject("NO_FILE", 400);
  }

  if (file.size === 0) return reject("EMPTY_FILE", 400);
  if (file.size > MAX_BYTES) return reject("TOO_LARGE", 413);

  const kind = classifyUpload(file.name, file.type);
  if (!kind) return reject("UNSUPPORTED", 415);

  const bytes = new Uint8Array(await file.arrayBuffer());

  // 2. Service role from here on: it bypasses RLS, so user.id must come from
  //    the verified session above and never from the request body.
  const admin = createSupabaseAdminClient();

  // 3. Where the note will go (WP-1.7): settled before anything is charged
  //    or archived, so a viewer is refused up front.
  const target = await workspaceForCreate(admin, user.id, {
    requested: requestedWorkspace,
    cookie: await readActiveWorkspaceCookie(user.id),
  });
  if (!target.ok) {
    return NextResponse.json({ error: target.error, code: "WORKSPACE_REFUSED" }, { status: target.status });
  }

  // 4. Charge the daily AI budget only once the upload is known to be valid.
  const quota = await consumeAiQuota(admin, user.id, "ingest");
  if (!quota.ok) return quotaRefusal(quota);

  return ingestStream((emit) =>
    runIngest({
      admin,
      userId: user.id,
      workspaceId: target.workspaceId,
      source: { filename: file.name, mimeType: file.type, kind, bytes },
      emit,
    }),
  );
}
