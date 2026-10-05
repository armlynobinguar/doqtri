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
 * is anchored, or Stellar could not be reached to find out.
 */
export async function deleteNote(id: string): Promise<{
  title: string;
  purgedUploads: number;
}> {
  const res = await fetch(`/api/notes/${id}`, { method: "DELETE" });
  const payload = (await res.json().catch(() => null)) as {
    error?: string;
    code?: string;
    title?: string;
    purgedUploads?: number;
  } | null;

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
