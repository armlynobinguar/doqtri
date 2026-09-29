import type { IngestErrorCode } from "@/lib/ingest/errors";

/**
 * The ingest progress protocol: /api/ingest answers with NDJSON, one event per
 * line, so the dialog can show which stage is running instead of a spinner
 * that may never stop. Client-safe.
 */
export const INGEST_STAGES = ["upload", "extract", "model", "markdown", "vault"] as const;

export type IngestStage = (typeof INGEST_STAGES)[number];

export const STAGE_LABELS: Record<IngestStage, string> = {
  upload: "Upload",
  extract: "Extract text",
  model: "AI formatting",
  markdown: "Markdown",
  vault: "Save to vault",
};

export type IngestEvent =
  | {
      type: "stage";
      stage: IngestStage;
      status: "active" | "done" | "skipped";
      /** Sent with `upload: done` once the original is archived and retryable. */
      ingestId?: string;
    }
  | { type: "ping" }
  | { type: "result"; id: string; title: string; mindmapped: boolean }
  | {
      type: "error";
      code: IngestErrorCode;
      message: string;
      stage: IngestStage | null;
      ingestId: string | null;
    };

/**
 * Reads an NDJSON body, calling `onEvent` per line. Resolves when the stream
 * ends; the caller decides what an end without a `result`/`error` means.
 */
export async function readIngestStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: IngestEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as IngestEvent);
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as IngestEvent);
}
