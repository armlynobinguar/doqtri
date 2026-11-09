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
 * A rename the server refused: its message, with the HTTP status and the
 * answer's `code` (TITLE_TAKEN, LOCKED, NOT_LOCK_HOLDER, BAD_TITLE, ...) for
 * a caller that handles some refusals itself (DOQ-36).
 */
export class RenameError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RenameError";
  }
}

/**
 * Renames a note through the API. Throws a RenameError with the server's reason — notably
 * when another note already has the title, which the dialog shows inline.
 * `session` is the open editor's edit session, when the rename goes through
 * it: the server checks the note's lock against it before it rewrites the
 * title heading.
 */
export async function renameNote(
  id: string,
  title: string,
  session?: string,
): Promise<RenamedNote> {
  const res = await fetch(`/api/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session ? { title, session } : { title }),
  });
  const payload = (await res.json().catch(() => null)) as {
    error?: string;
    code?: string;
    title?: string;
    previousTitle?: string;
  } | null;

  if (!res.ok || !payload?.title) {
    throw new RenameError(
      payload?.error ?? `Could not rename note (${res.status})`,
      res.status,
      typeof payload?.code === "string" ? payload.code : undefined,
    );
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
