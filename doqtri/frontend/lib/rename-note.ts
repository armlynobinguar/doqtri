import { fetchOrNoResponse, readJson } from "@/lib/no-response";

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
  // A 200 is the rename done, even if its body was lost on the way.
  const payload = (await readJson(res).catch((error: unknown) => {
    if (res.ok) return null;
    throw error;
  })) as {
    error?: string;
    title?: string;
    previousTitle?: string;
  } | null;

  if (!res.ok) {
    throw new Error(payload?.error ?? `Could not rename note (${res.status})`);
  }

  return { title: payload?.title ?? title, previousTitle: payload?.previousTitle ?? "" };
}
