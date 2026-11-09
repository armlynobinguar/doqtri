import { fetchOrNoResponse, isNoAnswer, NoResponseError, readJson } from "@/lib/no-response";

/** Carries the server's refusal code, so the UI can react to `ANCHORED`. */
export class DeleteNoteError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "DeleteNoteError";
    this.code = code;
  }
}

/**
 * Permanently deletes a note through the API: the row, its ingest attempts,
 * and the archived originals. Throws with the server's reason, which is what
 * the UI shows for the two refusals that are not the caller's fault — the note
 * is anchored, or Stellar could not be reached to find out. Throws
 * NoResponseError when no answer came, in which case the delete may have
 * happened.
 */
export async function deleteNote(id: string): Promise<{
  title: string;
  purgedUploads: number;
}> {
  const res = await fetchOrNoResponse(`/api/notes/${id}`, { method: "DELETE" });
  // A 200 is the note deleted, even if its body was lost on the way.
  const payload = (await readJson(res).catch((error: unknown) => {
    if (res.ok) return null;
    throw error;
  })) as {
    error?: string;
    code?: string;
    title?: string;
    purgedUploads?: number;
  } | null;

  if (isNoAnswer(res.status, payload)) throw new NoResponseError();
  if (!res.ok) {
    throw new DeleteNoteError(
      payload?.error ?? `Could not delete note (${res.status})`,
      payload?.code,
    );
  }

  return {
    title: payload?.title ?? "Untitled",
    purgedUploads: payload?.purgedUploads ?? 0,
  };
}
