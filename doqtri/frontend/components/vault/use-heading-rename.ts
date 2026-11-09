"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { decideHeadingRename, movesBaseline, type HeadingNotice } from "@/lib/heading-rename";
import { normalizeConcept } from "@/lib/mindmap-types";
import { RenameError, renameNote, type RenamedNote } from "@/lib/rename-note";

/** What a check needs from the workspace at the moment it runs. */
export type HeadingCheck = {
  /** The editor's text now. Read when the check runs, which may be after a rename in flight. */
  text(): string;
  /** False while the copy is read-only or its lock status is still loading: nothing fires then. */
  canRename(): boolean;
  /**
   * Renames through the open editor (DocWorkspace's renameHere): saves the
   * text first, then runs `request` in the save queue with the editor's
   * edit session.
   */
  rename(request: (session: string) => Promise<RenamedNote>): Promise<RenamedNote>;
  /** How many other notes link to this one under its current title. */
  backlinks(): number;
  /** The rename landed: refresh what shows the title. */
  onRenamed(renamed: RenamedNote): void;
};

/** Lock refusals: the edit-lock banner already says who has the note. */
const LOCK_CODES = new Set(["LOCKED", "NOT_LOCK_HOLDER"]);

/**
 * Renames the note when its title heading is edited (DOQ-36). The rule is
 * lib/heading-rename.ts; this decides when it runs and keeps one rename in
 * flight at a time.
 *
 * `check()` is called when an edit settles (the 700 ms that drives the save)
 * and when the caret leaves the title line, never per keystroke. It compares
 * the text with the baseline: the text the last check settled on, which
 * stays put while the heading is only emptied or not yet a valid title, so
 * retyping a heading still renames once it is typed. A rename is a
 * title-only PATCH through renameHere, which saves the text with the new
 * heading first, so the server sees the heading already renamed and leaves
 * the text alone.
 *
 * One rename runs at a time: a check while one is in flight runs again when
 * it is done, against the text and title then, so the latest heading wins
 * and no two requests race.
 *
 * The notice is the one line at the heading: a clash (another note has the
 * title; nothing is renamed, the text keeps the heading, and the same title
 * is not asked for again until the heading changes), or after a rename,
 * how many notes still link to the old title.
 *
 * `title` is the title to show: the page's, or the one a rename just set
 * until the page's data catches up (router.refresh). This is where DOQ-32's
 * optimistic rename overlay takes over.
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
  // The title the next comparison uses: the page's, or the newer one a
  // rename here set before the page has caught up.
  const titleRef = useRef(title);
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  const baselineRef = useRef(initialMarkdown);
  const busyRef = useRef(false);
  const againRef = useRef(false);
  const lastCheckRef = useRef<HeadingCheck | null>(null);

  const [notice, setNoticeState] = useState<HeadingNotice | null>(null);
  const noticeRef = useRef(notice);
  const setNotice = useCallback((next: HeadingNotice | null) => {
    noticeRef.current = next;
    setNoticeState(next);
  }, []);

  // A rename's title, shown until the page's own title moves off `from`.
  const [renamedTo, setRenamedTo] = useState<{ from: string; to: string } | null>(null);
  const shownTitle = renamedTo && renamedTo.from === title ? renamedTo.to : title;

  const check = useCallback(
    function run(context?: HeadingCheck) {
      if (context) lastCheckRef.current = context;
      const ctx = lastCheckRef.current;
      if (!ctx) return;
      if (busyRef.current) {
        againRef.current = true;
        return;
      }

      // Nothing fires from a copy that cannot be edited. Its text changes
      // only from outside, and those loads reset the baseline themselves.
      if (!ctx.canRename()) return;
      const text = ctx.text();

      const current = titleRef.current;
      const decision = decideHeadingRename(baselineRef.current, text, current);
      if (!decision.rename) {
        if (movesBaseline(decision.reason)) baselineRef.current = text;
        // Back to the title, or no heading to rename to: the clash is over.
        if (noticeRef.current?.kind === "clash") setNotice(null);
        return;
      }

      // Refused already; asking again would only be refused again.
      const shown = noticeRef.current;
      if (
        shown?.kind === "clash" &&
        normalizeConcept(shown.heading) === normalizeConcept(decision.title) &&
        normalizeConcept(shown.title) === normalizeConcept(current)
      ) {
        return;
      }

      busyRef.current = true;
      const backlinks = ctx.backlinks();
      ctx
        .rename((session) => renameNote(docId, decision.title, session))
        .then(
          (renamed) => {
            // The text that named the new title is what the next edit is compared with.
            baselineRef.current = text;
            titleRef.current = renamed.title;
            setRenamedTo({ from: current, to: renamed.title });
            const previousTitle = renamed.previousTitle || current;
            setNotice(backlinks > 0 ? { kind: "renamed", title: renamed.title, previousTitle, backlinks } : null);
            ctx.onRenamed(renamed);
          },
          (error: unknown) => {
            if (error instanceof RenameError) {
              if (error.code === "TITLE_TAKEN") {
                setNotice({ kind: "clash", heading: decision.title, title: current });
              } else if (!LOCK_CODES.has(error.code ?? "") && error.status !== 423) {
                toast.error(error.message);
              }
            }
            // Anything else is a save that failed first, which the save
            // status already shows. The baseline stays, so the next settled
            // edit tries again.
          },
        )
        .finally(() => {
          busyRef.current = false;
          if (againRef.current) {
            againRef.current = false;
            run();
          }
        });
    },
    [docId, setNotice],
  );

  /** Text loaded from outside (a reload, a regenerate): the next edit is compared with it. */
  const reset = useCallback(
    (text: string) => {
      baselineRef.current = text;
      if (noticeRef.current?.kind === "clash") setNotice(null);
    },
    [setNotice],
  );

  /**
   * Any rename that went through the open editor, the explorer's included:
   * the next comparison uses the new title, and the text the rename wrote
   * when it rewrote the heading. A notice names the old title, so it goes
   * (a rename from the heading sets its own once this returns).
   */
  const noteRenamed = useCallback(
    (renamed: string, text?: string) => {
      titleRef.current = renamed;
      if (text !== undefined) baselineRef.current = text;
      setNotice(null);
    },
    [setNotice],
  );

  const dismiss = useCallback(() => setNotice(null), [setNotice]);

  return { notice, title: shownTitle, check, reset, noteRenamed, dismiss };
}
