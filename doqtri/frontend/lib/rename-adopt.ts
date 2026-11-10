import type { RenamedNote } from "@/lib/rename-note";
import { hasControlCharacters } from "@/lib/title";
import { isTitleHeading, rewriteTitleHeading } from "@/lib/title-heading";

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

/**
 * What the open editor does with its line 1 after a rename from elsewhere
 * (the explorer) that the editor did not take new text from (DOQ-46): the
 * answer carried none, because the server found line 1 saying something
 * other than the old title, or adoptRename() took nothing.
 *
 * Line 1 is rewritten to `# <new title>` only when the editor's guard holds
 * it (`held`): it is the note's title line, even while it says something
 * else, such as a title being retyped whose rename had not fired yet, or an
 * older rename that left it behind. A line 1 the guard does not hold is the
 * student's own (`# Introduction`), and is left as it is, as the server
 * left it.
 *
 *   keep      line 1 already says the new title, is not held or not a `# `
 *             heading, or the new title cannot be a title line
 *   rewrite   `text` is the editor's text with line 1 as `# <new title>`
 *             and nothing else changed; `check` says the server did not
 *             write that line, so the note's title-line safety
 *             (lib/title-line-safety.ts) must allow it first
 */
export type TitleLineAfterRename = { kind: "keep" } | { kind: "rewrite"; text: string; check: boolean };

export function titleLineAfterRename(params: {
  renamed: RenamedNote;
  /** The text the editor shows now. */
  text: string;
  /** Whether the editor's guard holds line 1 as the title line. */
  held: boolean;
}): TitleLineAfterRename {
  const { renamed, text, held } = params;
  const title = renamed.title.trim();
  if (!held || !title || hasControlCharacters(title)) return { kind: "keep" };
  const newline = text.indexOf("\n");
  const end = newline === -1 ? text.length : newline;
  const lineEnd = end > 0 && text[end - 1] === "\r" ? end - 1 : end;
  const line = text.slice(0, lineEnd);
  if (!/^#[ \t]/.test(line)) return { kind: "keep" };
  // An emptied `# ` is a title line too, but says no title: it gets the new one.
  if (!/^#[ \t]+$/.test(line) && isTitleHeading(line, title)) return { kind: "keep" };
  return { kind: "rewrite", text: `# ${title}${text.slice(lineEnd)}`, check: renamed.markdown === undefined };
}
