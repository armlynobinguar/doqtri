import type { SupabaseClient } from "@supabase/supabase-js";
import { extractDocumentText, formatWithModel, type UploadKind } from "@/lib/openai";
import { generateAndStoreMindmap } from "@/lib/mindmap-store";
import { deriveTitle, uniqueTitle } from "@/lib/title";
import { IngestFailure, INGEST_ERRORS } from "@/lib/ingest/errors";
import type { IngestEvent, IngestStage } from "@/lib/ingest/events";

/**
 * The ingest pipeline shared by /api/ingest and /api/ingest/retry:
 * upload -> extract -> model -> markdown -> vault, reporting each stage as it
 * runs and failing with a typed code instead of hanging.
 *
 * Server-only, and runs with the service role: `userId` must come from the
 * verified session, never from the request body.
 */

function ms(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Kept under the route's `maxDuration` (300 s) so a timeout is ours to report. */
const EXTRACT_TIMEOUT_MS = () => ms("INGEST_EXTRACT_TIMEOUT_MS", 30_000);
const MODEL_TIMEOUT_MS = () => ms("INGEST_MODEL_TIMEOUT_MS", 180_000);
const TOTAL_BUDGET_MS = 280_000;
const MINDMAP_MAX_MS = 60_000;
const HEARTBEAT_MS = 10_000;

export type IngestSource = {
  filename: string;
  mimeType: string;
  kind: UploadKind;
  bytes: Uint8Array;
  /** Set on retry: the original is already archived under this ingest row. */
  ingestId?: string;
};

type Emit = (event: IngestEvent) => void;

export async function runIngest(params: {
  admin: SupabaseClient;
  userId: string;
  source: IngestSource;
  /** Skip the AI formatting pass and keep the extracted text as the note. */
  raw?: boolean;
  emit: Emit;
}): Promise<void> {
  const { admin, userId, source, emit } = params;
  const startedAt = Date.now();
  let stage: IngestStage = "upload";
  let ingestId: string | null = source.ingestId ?? null;

  const begin = (next: IngestStage) => {
    stage = next;
    emit({ type: "stage", stage: next, status: "active" });
  };
  const finish = (done: IngestStage) => emit({ type: "stage", stage: done, status: "done" });

  try {
    // 1. Upload: archive the original first, so every later failure is retryable.
    begin("upload");
    if (ingestId) {
      await admin
        .from("ingests")
        .update({ status: "pending", error_code: null, error: null, updated_at: new Date().toISOString() })
        .eq("id", ingestId)
        .eq("user_id", userId);
    } else {
      ingestId = await archiveUpload(admin, userId, source);
    }
    emit({ type: "stage", stage: "upload", status: "done", ingestId: ingestId ?? undefined });

    // 2. Extract. No signal to pass, so the timeout abandons the work rather
    //    than cancelling it; the response still ends on time.
    begin("extract");
    const text = await withTimeout(
      () => extractDocumentText(source.bytes, source.kind),
      EXTRACT_TIMEOUT_MS(),
      "EXTRACT_TIMEOUT",
    ).catch((error: unknown) => {
      if (error instanceof IngestFailure) throw error;
      throw new IngestFailure("EXTRACT_FAILED", detail(error, INGEST_ERRORS.EXTRACT_FAILED.message));
    });
    if (text !== null && text.trim().length === 0) throw new IngestFailure("NO_TEXT");
    finish("extract");

    // 3. Model. A PDF has no extracted text to fall back on, so `raw` only
    //    applies to the text paths.
    let markdown: string;
    if (params.raw && text !== null) {
      emit({ type: "stage", stage: "model", status: "skipped" });
      markdown = text;
    } else {
      begin("model");
      const heartbeat = setInterval(() => emit({ type: "ping" }), HEARTBEAT_MS);
      try {
        markdown = await withTimeout(
          (signal) =>
            formatWithModel({
              filename: source.filename,
              bytes: source.bytes,
              kind: source.kind,
              text,
              signal,
            }),
          MODEL_TIMEOUT_MS(),
          "MODEL_TIMEOUT",
        );
      } catch (error) {
        if (error instanceof IngestFailure) throw error;
        console.warn(`[ingest] model failed: ${detail(error, "unknown")}`);
        throw new IngestFailure("MODEL_FAILED");
      } finally {
        clearInterval(heartbeat);
      }
      finish("model");
    }

    // 4. Markdown.
    begin("markdown");
    markdown = markdown.trim();
    if (markdown.length === 0) throw new IngestFailure("EMPTY_OUTPUT");
    finish("markdown");

    // 5. Vault.
    begin("vault");
    const { data: existing, error: titlesError } = await admin
      .from("documents")
      .select("title")
      .eq("user_id", userId);
    if (titlesError) throw new IngestFailure("SAVE_FAILED", titlesError.message);

    const title = uniqueTitle(
      deriveTitle(markdown, source.filename),
      (existing ?? []).map((row: { title: string }) => row.title),
    );

    const { data: inserted, error: insertError } = await admin
      .from("documents")
      .insert({ user_id: userId, title, markdown })
      .select("id")
      .single();
    if (insertError || !inserted) {
      throw new IngestFailure("SAVE_FAILED", insertError?.message);
    }

    if (ingestId) {
      await admin
        .from("ingests")
        .update({
          status: "succeeded",
          document_id: inserted.id,
          error_code: null,
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", ingestId)
        .eq("user_id", userId);
    }

    // The note is saved; the mindmap is best-effort and gets whatever budget
    // is left. A missing map falls back to the heading tree and can be rebuilt.
    let mindmapped = true;
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    try {
      if (remaining < 5_000) throw new Error("no time left in the request budget");
      await withTimeout(
        (signal) =>
          generateAndStoreMindmap(admin, { id: inserted.id, userId, title, markdown, signal }),
        Math.min(remaining, MINDMAP_MAX_MS),
        "MODEL_TIMEOUT",
      );
    } catch (error) {
      mindmapped = false;
      console.warn(`[ingest] mindmap not generated for ${inserted.id}: ${detail(error, "unknown")}`);
    }
    finish("vault");

    emit({ type: "result", id: inserted.id, title, mindmapped });
  } catch (error) {
    const failure =
      error instanceof IngestFailure
        ? error
        : new IngestFailure("SAVE_FAILED", detail(error, INGEST_ERRORS.SAVE_FAILED.message));

    if (ingestId) {
      await admin
        .from("ingests")
        .update({
          status: "failed",
          error_code: failure.code,
          error: failure.message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", ingestId)
        .eq("user_id", userId);
    }

    emit({ type: "error", code: failure.code, message: failure.message, stage, ingestId });
  }
}

/**
 * Stores the original and records the attempt. Returns null when Storage is
 * unavailable: the import can still succeed, it just cannot be retried.
 */
async function archiveUpload(
  admin: SupabaseClient,
  userId: string,
  source: IngestSource,
): Promise<string | null> {
  const safeName = source.filename.replace(/[^\w.\-]+/g, "_").slice(-120);
  const objectPath = `${userId}/${crypto.randomUUID()}-${safeName}`;

  const { error: storageError } = await admin.storage
    .from("uploads")
    .upload(objectPath, source.bytes, {
      contentType: source.mimeType || "application/octet-stream",
      upsert: false,
    });
  if (storageError) {
    console.warn(`[ingest] original not archived: ${storageError.message}`);
    return null;
  }

  const { data, error } = await admin
    .from("ingests")
    .insert({ user_id: userId, object_path: objectPath, filename: source.filename, kind: source.kind })
    .select("id")
    .single();
  if (error || !data) {
    console.warn(`[ingest] attempt not recorded: ${error?.message}`);
    return null;
  }
  return data.id as string;
}

/** Runs `task` with an abort signal that fires, and a rejection, after `timeoutMs`. */
async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  code: "EXTRACT_TIMEOUT" | "MODEL_TIMEOUT",
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new IngestFailure(code));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function detail(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Wraps a pipeline run in an NDJSON streaming response. Writes after the
 * client disconnects are dropped; the run itself continues so its ingest row
 * still ends up succeeded or failed.
 */
export function ingestStream(run: (emit: Emit) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let open = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (event) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        await run(emit);
      } finally {
        if (open) controller.close();
        open = false;
      }
    },
    cancel() {
      open = false;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
