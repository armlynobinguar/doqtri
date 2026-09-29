import { INGEST_ERRORS, INGEST_ERROR_CODES, type IngestErrorCode } from "@/lib/ingest/errors";
import { readIngestStream, type IngestEvent, type IngestStage } from "@/lib/ingest/events";

export type IngestOutcome =
  | { ok: true; id: string; title: string; mindmapped: boolean }
  | {
      ok: false;
      code: IngestErrorCode;
      message: string;
      stage: IngestStage | null;
      ingestId: string | null;
    };

/**
 * Drives one /api/ingest or /api/ingest/retry request to a definite outcome.
 *
 * Every path ends in `ok` or a typed failure: a JSON rejection, an `error`
 * event, and a stream that just stops (function killed, network dropped) all
 * come back the same way, so the dialog can never be left spinning.
 */
export async function runIngestRequest(
  request: Promise<Response>,
  onEvent: (event: IngestEvent) => void,
): Promise<IngestOutcome> {
  let ingestId: string | null = null;
  let stage: IngestStage | null = null;

  const lost = (): IngestOutcome => ({
    ok: false,
    code: "CONNECTION_LOST",
    message: INGEST_ERRORS.CONNECTION_LOST.message,
    stage,
    ingestId,
  });

  let res: Response;
  try {
    res = await request;
  } catch {
    return lost();
  }

  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("ndjson") || !res.body) {
    const payload = (await res.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    const code = INGEST_ERROR_CODES.find((c) => c === payload?.code) ?? "CONNECTION_LOST";
    return {
      ok: false,
      code,
      message: payload?.error ?? INGEST_ERRORS[code].message,
      stage: null,
      ingestId: null,
    };
  }

  let outcome: IngestOutcome | null = null;
  try {
    await readIngestStream(res.body, (event) => {
      if (event.type === "stage") {
        stage = event.stage;
        if (event.ingestId) ingestId = event.ingestId;
      } else if (event.type === "result") {
        outcome = { ok: true, id: event.id, title: event.title, mindmapped: event.mindmapped };
      } else if (event.type === "error") {
        outcome = {
          ok: false,
          code: event.code,
          message: event.message,
          stage: event.stage,
          ingestId: event.ingestId,
        };
      }
      onEvent(event);
    });
  } catch {
    return outcome ?? lost();
  }

  return outcome ?? lost();
}
