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
 * `title` is the title to show: the page's, or the one a rename here set
 * while the page's data has not caught up (router.refresh). This is where
 * DOQ-32's optimistic rename overlay takes over.
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
  const { notice, overlay } = useSyncExternalStore(renamer.subscribe, renamer.getSnapshot, renamer.getSnapshot);

  return {
    notice,
    title: overlay ?? title,
    check: renamer.check,
    reset: renamer.reset,
    noteRenamed: renamer.noteRenamed,
    dismiss: renamer.dismiss,
  };
}
