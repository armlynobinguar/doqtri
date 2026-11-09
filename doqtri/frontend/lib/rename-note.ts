/**
 * What a rename did. `markdown`, `version` and `previousVersion` are there
 * only when the note's title heading was renamed with it (DOQ-35): the text
 * the server now holds, its save version, and the version that text
 * replaced, for an open editor to adopt as its saved copy.
 */
export type RenamedNote = {
  title: string;
  previousTitle: string;
  markdown?: string;
  version?: number;
  previousVersion?: number;
};

/**
 * Renames a note through the API. Throws with the server's reason — notably
 * when another note already has the title, which the dialog shows inline.
 */
export async function renameNote(
  id: string,
  title: string,
): Promise<RenamedNote> {
  const res = await fetch(`/api/notes/${id}`, {
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

  return { title: payload.title, previousTitle: payload.previousTitle ?? "", ...renamedText(payload) };
}

/** The rewritten text and its versions, when the answer carries all three. */
export function renamedText(payload: unknown): Pick<RenamedNote, "markdown" | "version" | "previousVersion"> {
  if (!payload || typeof payload !== "object") return {};
  const { markdown, version, previousVersion } = payload as Record<string, unknown>;
  if (
    typeof markdown !== "string" ||
    !Number.isSafeInteger(version) ||
    !Number.isSafeInteger(previousVersion)
  ) {
    return {};
  }
  return { markdown, version: version as number, previousVersion: previousVersion as number };
}
