import { fetchOrNoResponse, isNoAnswer, NoResponseError, readJson } from "@/lib/no-response";

/** What a rename did: the note's new title and the one it had. */
export type RenamedNote = { title: string; previousTitle: string };

/**
 * Renames a note through the API. Only the title changes: the note's text is
 * never touched (D-121). Throws with the server's reason — notably when
 * another note already has the title — or NoResponseError when no answer
 * came, in which case the rename may have happened.
 */
export async function renameNote(id: string, title: string): Promise<RenamedNote> {
  const res = await fetchOrNoResponse(`/api/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  // A 200 is the rename done, even if its body was lost on the way.
  const payload = (await readJson(res).catch((error: unknown) => {
    if (res.ok) return null;
    throw error;
  })) as {
    error?: string;
    title?: string;
    previousTitle?: string;
  } | null;

  if (isNoAnswer(res.status, payload)) throw new NoResponseError();
  if (!res.ok) throw new Error(payload?.error ?? `Could not rename note (${res.status})`);

  return { title: payload?.title ?? title, previousTitle: payload?.previousTitle ?? "" };
}
