"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { createHeadingRenamer } from "@/lib/heading-renamer";

export type { HeadingCheck } from "@/lib/heading-renamer";

/**
 * Renames the note when its title heading is edited (DOQ-36). The state and
 * its rules are lib/heading-renamer.ts; this keeps one per open note and
 * tells it the page's title.
 *
 * `title` is the confirmed title: the page's, or the one a rename here set
 * while the page's data has not caught up. The title being typed is a label
 * only, in the vault's draft store (`typed`, DOQ-44); a rename of it that
 * lands goes through DOQ-32's NoteOverlay. The draft goes when the note
 * closes, once nothing is on its way.
 */
export function useHeadingRename({
  docId,
  title,
  initialMarkdown,
}: {
  docId: string;
  /** The note's title, as the page's data has it. */
  title: string;
  initialMarkdown: string;
}) {
  const [renamer] = useState(() =>
    createHeadingRenamer({ docId, title, markdown: initialMarkdown, onError: (message) => toast.error(message) }),
  );
  useEffect(() => {
    renamer.setPageTitle(title);
  }, [renamer, title]);
  useEffect(() => {
    renamer.resume();
    return renamer.leave;
  }, [renamer]);
  const { notice, overlay } = useSyncExternalStore(renamer.subscribe, renamer.getSnapshot, renamer.getSnapshot);

  return {
    notice,
    title: overlay ?? title,
    check: renamer.check,
    typed: renamer.typed,
    reset: renamer.reset,
    noteRenamed: renamer.noteRenamed,
    dismiss: renamer.dismiss,
  };
}
