"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FileTextIcon } from "lucide-react";
import {
  completeLink,
  findLinkQuery,
  matchIndices,
  rankLinkSuggestions,
  type LinkQuery,
} from "@/lib/wikilinks";

const MAX_SUGGESTIONS = 50;
const POPUP_WIDTH = 300;
/** Room the list needs below the caret before it flips above it. */
const POPUP_ROOM = 280;

type Open = {
  link: LinkQuery;
  items: string[];
  index: number;
  caret: DOMRect;
};

/**
 * Styles a mirror div has to share with the textarea so its text wraps at the
 * same places — the usual caret-coordinates technique, since a textarea
 * exposes no geometry for its caret.
 */
const MIRRORED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "fontFeatureSettings",
  "textAlign",
  "textTransform",
  "textIndent",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
] as const;

/** Viewport rect of the caret at `pos` in `textarea`. */
function caretRect(textarea: HTMLTextAreaElement, pos: number): DOMRect {
  const style = getComputedStyle(textarea);
  const box = textarea.getBoundingClientRect();
  const mirror = document.createElement("div");
  for (const prop of MIRRORED) mirror.style[prop] = style[prop];
  Object.assign(mirror.style, {
    position: "fixed",
    top: `${box.top - textarea.scrollTop}px`,
    left: `${box.left - textarea.scrollLeft}px`,
    visibility: "hidden",
    overflow: "hidden",
    height: "auto",
  });
  mirror.textContent = textarea.value.slice(0, pos);
  const marker = document.createElement("span");
  // A zero-width character keeps the span on the caret's line.
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const rect = marker.getBoundingClientRect();
  mirror.remove();
  return rect;
}

/**
 * Replaces the selection through the browser's own editing path, so the
 * change lands in the textarea's undo stack and fires the `input` event the
 * editor's onChange listens to.
 */
function replaceRange(
  textarea: HTMLTextAreaElement,
  from: number,
  to: number,
  insert: string,
) {
  textarea.focus();
  textarea.setSelectionRange(from, to);
  const inserted = document.execCommand("insertText", false, insert);
  if (!inserted) {
    textarea.setRangeText(insert, from, to, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * Obsidian-style `[[` autocomplete for the markdown editor's textarea. Typing
 * `[[` lists the vault's notes, narrowed as you type; ↑↓ move, Enter or Tab
 * completes the link, Esc dismisses until the caret leaves that link.
 *
 * Listens on `containerRef` in the capture phase so it sees keys before the
 * editor's own handlers (which would otherwise turn Enter into list
 * continuation and Tab into indentation).
 */
export function WikilinkSuggest({
  containerRef,
  titles,
}: {
  containerRef: RefObject<HTMLElement | null>;
  titles: string[];
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const openRef = useRef(open);
  const titlesRef = useRef(titles);
  const listRef = useRef<HTMLDivElement>(null);
  // The `start` of a link dismissed with Esc; cleared once the caret leaves it.
  const dismissedRef = useRef<number | null>(null);
  // Completes the link from a click on a row; set by the listener effect.
  const chooseRef = useRef<((title: string) => void) | null>(null);

  // The ref is written alongside the state so key handlers see a change
  // before React has re-rendered.
  const show = (next: Open | null) => {
    openRef.current = next;
    setOpen(next);
  };

  useEffect(() => {
    titlesRef.current = titles;
  }, [titles]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const textareaOf = (target: EventTarget | null) =>
      target instanceof HTMLTextAreaElement ? target : null;

    let textarea: HTMLTextAreaElement | null = null;
    let frame = 0;

    function show(next: Open | null) {
      openRef.current = next;
      setOpen(next);
    }

    function refresh(ta: HTMLTextAreaElement) {
      textarea = ta;
      const caret = ta.selectionStart;
      const link =
        caret === ta.selectionEnd ? findLinkQuery(ta.value, caret) : null;
      if (!link) dismissedRef.current = null;
      if (!link || link.start === dismissedRef.current) {
        show(null);
        return;
      }
      const items = rankLinkSuggestions(
        titlesRef.current,
        link.query,
        MAX_SUGGESTIONS,
      );
      if (items.length === 0) {
        show(null);
        return;
      }
      const prev = openRef.current;
      const sameQuery =
        prev?.link.start === link.start && prev.link.query === link.query;
      show({
        link,
        items,
        index: sameQuery ? Math.min(prev.index, items.length - 1) : 0,
        caret: caretRect(ta, caret),
      });
    }

    function choose(ta: HTMLTextAreaElement, state: Open, title: string) {
      const edit = completeLink(
        ta.value,
        ta.selectionStart,
        state.link,
        title,
      );
      replaceRange(ta, edit.from, edit.to, edit.insert);
      ta.setSelectionRange(edit.caret, edit.caret);
      // Landing inside an aliased link would reopen the list on the title
      // just chosen; treat the completion as a dismissal for this link.
      dismissedRef.current = state.link.start;
      refresh(ta);
    }

    function onKeyDown(e: KeyboardEvent) {
      const ta = textareaOf(e.target);
      if (!ta || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A key pressed before the scheduled refresh ran (fast typing, then
      // Enter) must act on the text as it is now.
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
        refresh(ta);
      }
      const state = openRef.current;
      if (!state) return;

      const move = (delta: number) =>
        show({
          ...state,
          index: (state.index + delta + state.items.length) % state.items.length,
        });

      switch (e.key) {
        case "ArrowDown":
          move(1);
          break;
        case "ArrowUp":
          move(-1);
          break;
        case "Enter":
        case "Tab":
          choose(ta, state, state.items[state.index]);
          break;
        case "Escape":
          dismissedRef.current = state.link.start;
          show(null);
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    }

    function onCaretMove(e: Event) {
      const ta = textareaOf(e.target);
      if (!ta) return;
      // Arrow keys that only moved the highlight must not reset it.
      if (
        e instanceof KeyboardEvent &&
        openRef.current &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        return;
      }
      // Deferred to the next frame: setting state from this native listener
      // runs before React's own onChange for the controlled textarea, and the
      // re-render then restores the textarea to its previous value — the
      // second `[` of a fast `[[` vanished.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh(ta);
      });
    }

    function onFocusOut(e: FocusEvent) {
      if (textareaOf(e.target)) show(null);
    }

    function onScroll() {
      if (openRef.current && textarea) refresh(textarea);
    }

    chooseRef.current = (title: string) => {
      const state = openRef.current;
      if (textarea && state) choose(textarea, state, title);
    };

    container.addEventListener("keydown", onKeyDown, true);
    container.addEventListener("input", onCaretMove);
    container.addEventListener("keyup", onCaretMove);
    container.addEventListener("mouseup", onCaretMove);
    container.addEventListener("focusout", onFocusOut);
    container.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("input", onCaretMove);
      container.removeEventListener("keyup", onCaretMove);
      container.removeEventListener("mouseup", onCaretMove);
      container.removeEventListener("focusout", onFocusOut);
      container.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      chooseRef.current = null;
    };
  }, [containerRef]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${open.index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open]);

  if (!open) return null;

  const { caret } = open;
  const below = window.innerHeight - caret.bottom >= POPUP_ROOM;
  const left = Math.max(
    8,
    Math.min(caret.left, window.innerWidth - POPUP_WIDTH - 8),
  );

  return createPortal(
    <div
      role="listbox"
      aria-label="Link to note"
      // Clicking a row must not blur the textarea, or focusout closes the list.
      onMouseDown={(e) => e.preventDefault()}
      className="glass-float text-popover-foreground fixed z-50 flex max-h-[260px] w-[300px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl p-1"
      style={
        below
          ? { left, top: caret.bottom + 4 }
          : { left, bottom: window.innerHeight - caret.top + 4 }
      }
    >
      <div ref={listRef} className="min-h-0 overflow-y-auto">
        {open.items.map((title, i) => (
          <div
            key={title}
            role="option"
            aria-selected={i === open.index}
            data-index={i}
            // shadcn's `data-selected:` variant matches `[data-selected="true"]`.
            data-selected={i === open.index}
            onMouseEnter={() => show({ ...open, index: i })}
            onClick={() => chooseRef.current?.(title)}
            className="text-muted-foreground data-selected:text-foreground flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm select-none data-selected:bg-[var(--glass-strong)] pointer-coarse:py-2.5 pointer-coarse:text-[15px]"
          >
            <FileTextIcon className="size-3.5 shrink-0 opacity-60" strokeWidth={1.5} />
            <Highlighted title={title} query={open.link.query} />
          </div>
        ))}
      </div>
      <div className="text-muted-foreground border-border mt-1 flex gap-3 border-t px-2 pt-1.5 pb-0.5 text-[11px] pointer-coarse:hidden">
        <span>↑↓ navigate</span>
        <span>↵ link</span>
        <span>esc dismiss</span>
      </div>
    </div>,
    document.body,
  );
}

/** The title with the characters matching the typed query emphasised. */
function Highlighted({ title, query }: { title: string; query: string }) {
  const hits = new Set(matchIndices(title, query));
  // Runs of matched / unmatched text, so surrogate pairs stay whole.
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < title.length; i++) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += title[i];
    else runs.push({ text: title[i], hit });
  }
  return (
    <span className="truncate">
      {runs.map((run, i) =>
        run.hit ? (
          <mark key={i} className="text-foreground bg-transparent font-semibold">
            {run.text}
          </mark>
        ) : (
          run.text
        ),
      )}
    </span>
  );
}
