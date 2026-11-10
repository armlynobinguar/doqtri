import { decideHeadingRename, movesBaseline, type HeadingNotice } from "@/lib/heading-rename";
import { normalizeConcept } from "@/lib/mindmap-types";
import { RenameError, renameNote as defaultRenameNote, type RenamedNote } from "@/lib/rename-note";

/**
 * When an edit of a note's title heading renames the note (DOQ-36), and what
 * the editor shows meanwhile. The rule itself is lib/heading-rename.ts; this
 * is the state around it, kept apart from React so it can be tested whole.
 * components/vault/use-heading-rename.ts wraps it for the workspace.
 *
 * `check()` runs when an edit settles and when the caret leaves the title
 * line, never per keystroke. It compares the editor's text with the
 * baseline: the text the last check settled on, which stays put while the
 * heading is only emptied or not yet a valid title, so retyping a heading
 * still renames. The rename goes through the open editor's rename path,
 * which saves the text first, so the server sees the heading already renamed
 * and leaves the text alone. One rename runs at a time; a check made while
 * one is in flight runs again once it is done, on the text and title then.
 *
 * Titles. `latest` is the note's title as far as this editor knows: the
 * page's, or the one its own rename just set. A rename here is ahead of the
 * page's data until router.refresh() brings it, so the renamed titles not yet
 * seen on the page are kept in order (`pending`), and the title to show is
 * the newest of them. When the page's title moves:
 *   - to a pending title: the page caught up that far; older ones are dropped,
 *     and once the newest arrives nothing is pending
 *   - to anything else (a rename from the explorer or another tab): that is
 *     the title now, and nothing predicted still holds
 * A page title lagging behind the newest rename therefore never overwrites
 * `latest`, and nothing here outlives a change of the page's title it did
 * not predict.
 *
 * The notice is the one line at the heading: a clash (another note has the
 * title; nothing is renamed, the text keeps the heading, and the same title
 * is not asked for again until the heading changes), or after a rename, how
 * many notes still link to the old title.
 *
 * A rename names the title it renames from (`expectedTitle`). When the note
 * was renamed elsewhere meanwhile the server refuses with TITLE_CHANGED: no
 * rename and no clash, the heading as it is now becomes the baseline, and the
 * page is refreshed to show the title the note has.
 */

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
  /** Fetches the page's data again, so everything showing the title catches up. */
  refresh(): void;
};

export type HeadingRenamerSnapshot = {
  notice: HeadingNotice | null;
  /** The title to show in place of the page's, while a rename here is ahead of it; else null. */
  overlay: string | null;
};

/** Lock refusals: the edit-lock banner already says who has the note. */
const LOCK_CODES = new Set(["LOCKED", "NOT_LOCK_HOLDER"]);

export function createHeadingRenamer(init: {
  docId: string;
  /** The note's title, as the page's data has it. */
  title: string;
  /** The text the editor opened with. */
  markdown: string;
  renameNote?: typeof defaultRenameNote;
  /** Shows a refusal nothing else explains. */
  onError?: (message: string) => void;
}) {
  const renameNote = init.renameNote ?? defaultRenameNote;
  let pageTitle = init.title;
  let latest = init.title;
  let pending: string[] = [];
  let baseline = init.markdown;
  let busy = false;
  let again = false;
  let last: HeadingCheck | null = null;
  let notice: HeadingNotice | null = null;
  // The answers to this editor's own heading renames, told apart from any
  // other rename that goes through the editor (the explorer's).
  const own = new WeakSet<RenamedNote>();

  let snapshot: HeadingRenamerSnapshot = { notice: null, overlay: null };
  const listeners = new Set<() => void>();
  function emit() {
    const overlay = pending.length > 0 ? latest : null;
    if (snapshot.notice === notice && snapshot.overlay === overlay) return;
    snapshot = { notice, overlay };
    for (const listener of listeners) listener();
  }
  function setNotice(next: HeadingNotice | null) {
    notice = next;
    emit();
  }

  function check(context?: HeadingCheck) {
    if (context) last = context;
    const ctx = last;
    if (!ctx) return;
    if (busy) {
      again = true;
      return;
    }
    // Nothing fires from a copy that cannot be edited. Its text changes only
    // from outside, and those loads reset the baseline themselves.
    if (!ctx.canRename()) return;

    const text = ctx.text();
    const current = latest;
    const decision = decideHeadingRename(baseline, text, current);
    if (!decision.rename) {
      if (movesBaseline(decision.reason)) baseline = text;
      // Back to the title, or no heading to rename to: the clash is over.
      if (notice?.kind === "clash") setNotice(null);
      return;
    }

    // Refused already; asking again would only be refused again.
    if (
      notice?.kind === "clash" &&
      normalizeConcept(notice.heading) === normalizeConcept(decision.title) &&
      normalizeConcept(notice.title) === normalizeConcept(current)
    ) {
      return;
    }

    busy = true;
    const backlinks = ctx.backlinks();
    ctx
      .rename(async (session) => {
        const renamed = await renameNote(init.docId, decision.title, session, current);
        own.add(renamed);
        return renamed;
      })
      .then(
        (renamed) => {
          // The text that named the new title is what the next edit is compared with.
          baseline = text;
          latest = renamed.title;
          pending = renamed.title === pageTitle ? [] : [...pending, renamed.title];
          const previousTitle = renamed.previousTitle || current;
          setNotice(backlinks > 0 ? { kind: "renamed", title: renamed.title, previousTitle, backlinks } : null);
          emit();
          ctx.refresh();
        },
        (error: unknown) => {
          if (!(error instanceof RenameError)) {
            // A save that failed first, which the save status already shows.
            // The baseline stays, so the next settled edit tries again.
            return;
          }
          if (error.code === "TITLE_TAKEN") {
            setNotice({ kind: "clash", heading: decision.title, title: current });
          } else if (error.code === "TITLE_CHANGED") {
            // Renamed elsewhere: theirs stands. This heading is compared from now on.
            baseline = text;
            if (error.title) latest = error.title;
            pending = [];
            setNotice(null);
            emit();
            ctx.refresh();
          } else if (!LOCK_CODES.has(error.code ?? "") && error.status !== 423) {
            init.onError?.(error.message);
          }
        },
      )
      .finally(() => {
        busy = false;
        if (again) {
          again = false;
          check();
        }
      });
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,

    check,

    /** The page's data has this title now (see "Titles" above). */
    setPageTitle(title: string) {
      if (title === pageTitle) return;
      pageTitle = title;
      const at = pending.lastIndexOf(title);
      if (at >= 0) {
        pending = pending.slice(at + 1);
        if (pending.length === 0) latest = title;
      } else {
        pending = [];
        latest = title;
      }
      emit();
    },

    /** Text loaded from outside (a reload, a regenerate): the next edit is compared with it. */
    reset(text: string) {
      baseline = text;
      if (notice?.kind === "clash") setNotice(null);
    },

    /**
     * Any rename that went through the open editor. For one from elsewhere
     * (the explorer), its title is the note's from now on, nothing predicted
     * holds, and the notice, which names an old title, goes; `text` is what
     * the rename wrote when it rewrote the heading. This editor's own renames
     * settle in check().
     */
    noteRenamed(renamed: RenamedNote, text?: string) {
      if (text !== undefined) baseline = text;
      if (own.has(renamed)) return;
      latest = renamed.title;
      pending = [];
      notice = null;
      emit();
    },

    dismiss() {
      setNotice(null);
    },

    /** The title the next check compares with. For tests. */
    get title() {
      return latest;
    },
  };
}

export type HeadingRenamer = ReturnType<typeof createHeadingRenamer>;
