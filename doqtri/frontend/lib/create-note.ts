/**
 * Creates a blank note (Obsidian-style) via the API.
 * Returns the new document id.
 */
export async function createBlankNote(title?: string): Promise<{
  id: string;
  title: string;
}> {
  const res = await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
  });
  const payload = (await res.json().catch(() => null)) as {
    error?: string;
    id?: string;
    title?: string;
  } | null;

  if (!res.ok || !payload?.id) {
    throw new Error(payload?.error ?? `Could not create note (${res.status})`);
  }

  return { id: payload.id, title: payload.title ?? "Untitled" };
}
