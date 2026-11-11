"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The note's title, set like a document title above its text (D-121): the
 * size and weight a `#` heading has in the editor (live-editor/theme.ts), on
 * the text's own column. Shared by the title bar and the demo's read-only
 * heading, inside `.doqtri-editor`, whose variables it reads.
 */
export const NOTE_TITLE_TEXT =
  "text-foreground text-[calc(var(--lp-font-size)*1.75)] leading-[1.3] font-bold tracking-[-0.015em]";

/** The title's place: the width and side padding of the editor's text column. */
export const NOTE_TITLE_COLUMN = "mx-auto w-full max-w-[46rem] px-[var(--lp-pad-x)] pt-5";

/**
 * The open note's title bar (D-121). `documents.title` is the one place a
 * note's title lives; the note's text neither holds nor follows it.
 *
 * It shows `title`, the note's title through the vault's pending renames, so
 * a rename from the explorer shows here at once, unless the field is being
 * edited: what is typed there is never overwritten. Enter or leaving the
 * field renames through `onRename`, the explorer's own rename, so the row,
 * the tab and the mindmap's root change in the same frame. Escape, a blank
 * field or the title unchanged puts the title back and renames nothing. A
 * title another note has is refused by `onRename` before any request: its
 * message shows under the field, and the field goes back to the title. Any
 * later refusal is the explorer's toast, and the title comes back with the
 * vault's overlay.
 *
 * `readOnly` (a conflict, the lock held elsewhere or loading, a viewer)
 * shows the title without letting it be changed.
 */
export function NoteTitleBar({
  title,
  readOnly,
  onRename,
  onDone,
}: {
  title: string;
  readOnly: boolean;
  /** Renames the note; throws, renaming nothing, when the title is taken. */
  onRename: (title: string) => void;
  /** Enter: where focus goes next (the start of the text). */
  onDone?: () => void;
}) {
  const field = useNoteTitleField({ title, readOnly, onRename, onDone });

  return (
    <div className={NOTE_TITLE_COLUMN}>
      <input
        type="text"
        aria-label="Note title"
        data-testid="note-title"
        value={field.value}
        readOnly={readOnly}
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(event) => field.change(event.target.value)}
        onFocus={field.focus}
        onBlur={field.blur}
        onKeyDown={(event) => {
          const target = event.currentTarget;
          const handled = field.keyDown({
            key: event.key,
            isComposing: event.nativeEvent.isComposing,
            blur: () => target.blur(),
          });
          if (handled) event.preventDefault();
        }}
        aria-invalid={field.error ? true : undefined}
        aria-describedby={field.error ? "note-title-error" : undefined}
        className={cn(
          NOTE_TITLE_TEXT,
          "placeholder:text-label w-full min-w-0 truncate rounded-none border-0 bg-transparent p-0 outline-none",
          "focus-visible:shadow-[inset_2px_0_0_0_color-mix(in_oklch,var(--ring)_60%,transparent)]",
          readOnly && "cursor-default",
        )}
      />
      {field.error ? (
        <p id="note-title-error" role="alert" className="text-muted-foreground mt-1 text-[12px]">
          {field.error}
        </p>
      ) : null}
    </div>
  );
}

/** A key pressed in the field, as much of it as the field reads. */
export type TitleFieldKey = {
  key: string;
  isComposing: boolean;
  /** Takes focus out of the field. */
  blur: () => void;
};

/**
 * The title bar's field, apart from its markup, so its rules can be tested
 * without a DOM: what it shows, and when it renames. See NoteTitleBar.
 */
export function useNoteTitleField({
  title,
  readOnly,
  onRename,
  onDone,
}: {
  title: string;
  readOnly: boolean;
  onRename: (title: string) => void;
  onDone?: () => void;
}) {
  const [value, setShownValue] = useState(title);
  // Read by blur, which can run before the render a change asked for.
  const valueRef = useRef(value);
  const setValue = (next: string) => {
    valueRef.current = next;
    setShownValue(next);
  };
  // The title `value` was last set from, to tell an edit from a new title.
  const [shown, setShown] = useState(title);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new title from outside (a rename from the explorer, or this one landing
  // or refused) replaces the field, unless it is being edited.
  if (shown !== title) {
    setShown(title);
    if (!focused || value === shown) setValue(title);
  }
  // A copy that turned read-only mid-edit drops what was typed.
  if (readOnly && value !== title) setValue(title);

  const commit = (typed: string) => {
    const next = typed.trim();
    if (!next || next === title) {
      setValue(title);
      return;
    }
    try {
      onRename(next);
      setValue(next);
    } catch (e) {
      setValue(title);
      setError(e instanceof Error ? e.message : "Could not rename note");
    }
  };

  return {
    value,
    error,
    change(next: string) {
      setValue(next);
      setError(null);
    },
    focus() {
      setFocused(true);
    },
    blur() {
      setFocused(false);
      if (!readOnly) commit(valueRef.current);
    },
    /** Whether the key was the field's: the caller then prevents its default. */
    keyDown(event: TitleFieldKey): boolean {
      if (event.isComposing) return false;
      if (event.key === "Enter") {
        // Leaving the field renames (blur), once.
        if (onDone) onDone();
        else event.blur();
        return true;
      }
      if (event.key === "Escape") {
        setValue(title);
        setError(null);
        return true;
      }
      return false;
    },
  };
}
