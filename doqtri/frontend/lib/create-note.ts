/**
 * Creates a note (Obsidian-style) via the API: blank, or seeded with a template
 * `body` (markdown without the `# Title` line). Returns the new document id.
 *
 * `workspaceId` is the workspace the vault is showing (WP-1.7); the server
 * checks the caller may add notes there. Without it the note goes into the
 * active workspace the server remembers.
 */
export async function createBlankNote(title?: string, body?: string, workspaceId?: string): Promise<{
  id: string;
  title: string;
}> {
  const res = await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    }),
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
