import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseAdminClient } from "@/lib/supabase/server";
import { consumeAiQuota, quotaRefusal } from "@/lib/ai-quota";
import { INGEST_ERRORS, type IngestErrorCode } from "@/lib/ingest/errors";
import { ingestStream, runIngest } from "@/lib/ingest/pipeline";
import type { UploadKind } from "@/lib/openai";

export const runtime = "nodejs";
export const maxDuration = 300;

function reject(code: IngestErrorCode, status: number) {
  return NextResponse.json({ error: INGEST_ERRORS[code].message, code }, { status });
}

/**
 * Re-runs a failed import from the original archived at upload time, so the
 * user never has to find the file again. `raw: true` skips the AI formatting
 * pass and keeps the extracted text, for when that pass is what keeps failing.
 *
 * Responds with the same NDJSON stream as /api/ingest.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return reject("NOT_SIGNED_IN", 401);

  let body: { ingestId?: unknown; raw?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return reject("NOT_FOUND", 400);
  }
  const ingestId = typeof body.ingestId === "string" ? body.ingestId : "";
  if (!/^[0-9a-f-]{36}$/i.test(ingestId)) return reject("NOT_FOUND", 400);

  const admin = createSupabaseAdminClient();

  // Scoped by user_id: the service role would otherwise read anyone's row.
  const { data: attempt } = await admin
    .from("ingests")
    .select("id, object_path, filename, kind, status")
    .eq("id", ingestId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!attempt || attempt.status === "succeeded") return reject("NOT_FOUND", 404);

  // A raw retry still builds the mindmap (and a PDF is read by the model), so
  // every retry draws on the budget.
  const quota = await consumeAiQuota(admin, user.id, "ingest-retry");
  if (!quota.ok) return quotaRefusal(quota);

  const { data: blob, error: downloadError } = await admin.storage
    .from("uploads")
    .download(attempt.object_path as string);
  if (downloadError || !blob) return reject("NOT_FOUND", 404);

  const bytes = new Uint8Array(await blob.arrayBuffer());

  return ingestStream((emit) =>
    runIngest({
      admin,
      userId: user.id,
      source: {
        filename: attempt.filename as string,
        mimeType: blob.type,
        kind: attempt.kind as UploadKind,
        bytes,
        ingestId,
      },
      raw: body.raw === true,
      emit,
    }),
  );
}
