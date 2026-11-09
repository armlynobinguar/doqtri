import { fetchOrNoResponse } from "@/lib/no-response";

/**
 * Renames a note through the API. Throws with the server's reason — notably
 * when another note already has the title — or NoResponseError when no
 * answer came, in which case the rename may have happened.
 */
export async function renameNote(
  id: string,
  title: string,
): Promise<{ title: string; previousTitle: string }> {
  const res = await fetchOrNoResponse(`/api/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const payload = (await res.json().catch(() => null)) as {
    error?: string;
    title?: string;
    previousTitle?: string;
  } | null;

  if (!res.ok || !payload?.title) {
    throw new Error(payload?.error ?? `Could not rename note (${res.status})`);
  }

  return { title: payload.title, previousTitle: payload.previousTitle ?? "" };
}
