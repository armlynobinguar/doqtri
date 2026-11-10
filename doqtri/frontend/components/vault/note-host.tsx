"use client";

import { DocWorkspace } from "@/components/vault/doc-workspace";
import { useNoteStore } from "@/components/vault/note-store";

/**
 * The open note's editor, in the vault shell's main pane (DOQ-43); see
 * note-store.tsx for why it lives here and not in the note page. Mounted
 * with `key` per note, so the edit lock and the saver start over for each
 * note exactly as when the page remounted it.
 */
export function NoteHost() {
  const store = useNoteStore();
  if (!store?.shown) return null;
  const { shown, docs, unsaved, recheck, leave } = store;
  return (
    <DocWorkspace
      key={shown.id}
      docs={docs}
      active={shown}
      unsaved={unsaved.get(shown.id)}
      recheck={recheck}
      onLeave={(copy) => leave(shown.id, copy)}
    />
  );
}
