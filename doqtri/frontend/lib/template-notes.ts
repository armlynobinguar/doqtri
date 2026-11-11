import { createBlankNote } from "@/lib/create-note";
import type { NoteTemplate } from "@/lib/templates";

type Created = { id: string; title: string };
type Create = (title: string, body: string, workspaceId?: string) => Promise<Created>;

/** Points every `[[wanted]]` link at the title the copy actually got. */
export function relink(body: string, renamed: ReadonlyMap<string, string>): string {
  let out = body;
  for (const [wanted, got] of renamed) {
    if (wanted !== got) out = out.split(`[[${wanted}]]`).join(`[[${got}]]`);
  }
  return out;
}

/**
 * "Use template": creates the template's linked notes first, then the main
 * note, so the main note's links can name the titles the server gave the
 * copies (it de-duplicates titles already in the workspace). Returns the main
 * note, which is the one to open, and how many linked notes came with it.
 */
export async function createFromTemplate(
  template: NoteTemplate,
  workspaceId?: string,
  create: Create = createBlankNote,
): Promise<Created & { linked: number }> {
  const renamed = new Map<string, string>();
  for (const note of template.linkedNotes ?? []) {
    const copy = await create(note.title, relink(note.body, renamed), workspaceId);
    renamed.set(note.title, copy.title);
  }
  const main = await create(template.title, relink(template.body, renamed), workspaceId);
  return { ...main, linked: renamed.size };
}
