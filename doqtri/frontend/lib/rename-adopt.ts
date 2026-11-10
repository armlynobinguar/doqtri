import type { RenamedNote } from "@/lib/rename-note";
import { rewriteTitleHeading } from "@/lib/title-heading";

/**
 * What an open editor takes from a rename of its note (DOQ-35): the version
 * and saved text to adopt, and the text to show. Null when it takes nothing.
 *
 *   no `markdown` in the answer     the heading did not change; nothing to take
 *   `previousVersion` is not the    the editor's copy was already behind the
 *   editor's version                note: adopting would hide that, so its own
 *                                   reload or conflict path deals with it, and
 *                                   the text it shows is left as it is
 *   otherwise                       the server's text becomes the saved copy at
 *                                   the new version; the editor shows it, or,
 *                                   when something was typed since `saved`,
 *                                   that text with the same heading change
 */
export function adoptRename(params: {
  renamed: RenamedNote;
  /** The save version the editor's saved text is at. */
  editorVersion: number;
  /** The text the editor last saved (its baseline). */
  saved: string;
  /** The text the editor shows now. */
  current: string;
}): { version: number; saved: string; text: string } | null {
  const { renamed, editorVersion, saved, current } = params;
  const { markdown, version, previousVersion } = renamed;
  if (markdown === undefined || version === undefined) return null;
  if (previousVersion !== editorVersion) return null;
  const text =
    current === saved
      ? markdown
      : (rewriteTitleHeading(current, renamed.previousTitle, renamed.title) ?? current);
  return { version, saved: markdown, text };
}
