import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { consumeAiQuota, quotaRefusal } from "@/lib/ai-quota";
import { classifyUpload } from "@/lib/openai";
import { INGEST_ERRORS, type IngestErrorCode } from "@/lib/ingest/errors";
import { ingestStream, runIngest } from "@/lib/ingest/pipeline";

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
  try {
    const form = await request.formData();
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

  // 3. Charge the daily AI budget only once the upload is known to be valid.
  const quota = await consumeAiQuota(admin, user.id, "ingest");
  if (!quota.ok) return quotaRefusal(quota);

  return ingestStream((emit) =>
    runIngest({
      admin,
      userId: user.id,
      source: { filename: file.name, mimeType: file.type, kind, bytes },
      emit,
    }),
  );
}
