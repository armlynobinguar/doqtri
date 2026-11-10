import type { RenamedNote } from "@/lib/rename-note";
import { hasControlCharacters } from "@/lib/title";
import { isTitleHeading } from "@/lib/title-heading";

/**
 * What the open editor's line 1 becomes once a rename from the explorer has
 * answered (DOQ-46), when the editor did not take text from the answer that
 * already says the new title: the server left line 1 alone (it said neither
 * title: a title being retyped whose own rename had not fired yet), the
 * editor could not adopt the rewrite, or line 1 was typed into while the
 * rename was on its way.
 *
 * Line 1 is rewritten to `# <new title>` only when all of these hold:
 *   - the editor's guard holds it: it is the note's title line. A line 1 it
 *     does not hold (`# Introduction`) is the student's own, and stays.
 *   - it says exactly what it said when the rename started (`lineBefore`):
 *     anything typed on it since is the student's, not the rename's
 *   - the copy can be edited, has no conflict waiting, and still goes by the
 *     new title
 *   - the server wrote that line itself, or the note's title-line safety
 *     allows it (lib/title-line-safety.ts). A read that fails is asked once
 *     more; failing again, nothing is decided and line 1 is left as it is.
 * The rewrite is an edit of the editor (TitleLineHandle.retitle), saved like
 * any other and undone as one step.
 *
 * Whenever it is not rewritten and does not say the new title, the guard
 * lets it go (release): line 1 is no longer the title line, and the title
 * shows above it. Only a copy whose renamed text is still on its way keeps
 * it: one with a conflict (its reload brings the stored text) or a read-only
 * one the server rewrote (its next lock poll loads it).
 */

/** What the settling needs from the workspace and the editor, read when it runs. */
export type TitleLineSettle = {
  renamed: RenamedNote;
  /** Line 1 when the rename started, before anything was saved for it. */
  lineBefore: string;
  /** The editor's title line, or null when no editor is mounted. */
  editor: {
    held(): boolean;
    line(): string;
    retitle(title: string, expected: string): string | null;
    release(): void;
  } | null;
  readOnly(): boolean;
  conflict(): boolean;
  /** The title the editor's title line goes by now. */
  title(): string;
  safety(): Promise<"allowed" | "blocked" | "unreadable">;
  /** Waits before a failed safety read is asked again. */
  wait(): Promise<void>;
  /** The editor's text after the rewrite: the heading renamer compares the next edit with it. */
  rewritten(text: string): void;
};

export type TitleLineSettled =
  /** Nothing to do: no editor, line 1 not the title line, or it says the new title. */
  | "none"
  /** Left for the renamed text on its way, or for a safety answer that could not be read. */
  | "left"
  | "rewritten"
  | "released";

/** Whether `line` is line 1 saying `title` (an emptied `# ` says none). */
function says(line: string, title: string): boolean {
  return !/^#[ \t]*$/.test(line) && isTitleHeading(line, title);
}

export async function settleTitleLine(params: TitleLineSettle): Promise<TitleLineSettled> {
  const { renamed, lineBefore, editor } = params;
  const title = renamed.title.trim();
  if (!editor || !editor.held()) return "none";
  if (says(editor.line(), title)) return "none";
  const serverWrote = renamed.markdown !== undefined;
  const release = (): TitleLineSettled => {
    editor.release();
    return "released";
  };
  if (params.conflict()) return "left";
  if (params.readOnly()) return serverWrote ? "left" : release();
  if (!title || hasControlCharacters(title) || editor.line() !== lineBefore) return release();

  if (!serverWrote) {
    let safety = await params.safety();
    if (safety === "unreadable") {
      await params.wait();
      safety = await params.safety();
    }
    if (safety === "unreadable") return "left";
    if (safety === "blocked") return release();
  }

  // Asked again after the reads: what happened meanwhile stands.
  if (!editor.held()) return "none";
  if (says(editor.line(), title)) return "none";
  if (params.conflict()) return "left";
  if (params.readOnly() || params.title() !== renamed.title || editor.line() !== lineBefore) return release();
  const text = editor.retitle(renamed.title, lineBefore);
  if (text === null) return release();
  params.rewritten(text);
  return "rewritten";
}
