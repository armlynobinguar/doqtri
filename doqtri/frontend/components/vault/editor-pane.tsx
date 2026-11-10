"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { FileTextIcon, NetworkIcon, SparklesIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { DoqtriLoader } from "@/components/brand/doqtri-loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { LiveMindmapPane } from "@/components/vault/live-mindmap-pane";
import type { MindmapRebuild } from "@/components/vault/use-mindmap-rebuild";
import type { HeadingNotice } from "@/lib/heading-rename";
import type { TitleLineSafety } from "@/lib/title-line-safety";
import { cn } from "@/lib/utils";
import type { EditorStats } from "@/lib/text-stats";

// CodeMirror measures the DOM, so the editor is never server-rendered — and
// none of it lands in the server bundle.
const MarkdownEditor = dynamic(() => import("@/components/vault/live-editor/markdown-editor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <DoqtriLoader className="w-14" />
    </div>
  ),
});

const PLACEHOLDER = "Write markdown. Wrap concepts in [[double brackets]].";

/*
 * Whether the live mindmap shows beside the editor: a per-browser choice, on
 * by default. Storage can be unavailable (private windows, blocked site
 * data); the toggle then still works for the session, it just is not kept.
 */
const MINDMAP_KEY = "doqtri:editor-mindmap";
const mindmapListeners = new Set<() => void>();
let mindmapFallback = true;

function readMindmapShown(): boolean {
  try {
    const stored = window.localStorage.getItem(MINDMAP_KEY);
    return stored === null ? mindmapFallback : stored !== "hidden";
  } catch {
    return mindmapFallback;
  }
}

function setMindmapShown(shown: boolean) {
  mindmapFallback = shown;
  try {
    window.localStorage.setItem(MINDMAP_KEY, shown ? "shown" : "hidden");
  } catch {
    // Kept in memory only; see above.
  }
  for (const listener of mindmapListeners) listener();
}

function subscribeMindmapShown(listener: () => void) {
  mindmapListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    mindmapListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function EditorPane({
  title,
  markdown,
  onChange,
  onRegenerate,
  linkTitles,
  concept,
  compact = false,
  readOnly = false,
  pending = false,
  onOpenNote,
  onStats,
  banner,
  headingNotice = null,
  onDismissHeadingNotice,
  onLeaveTitleLine,
  onTitleLine,
  titleLineWrite,
}: {
  /** The note's title, which its first line always says (D-120). */
  title: string;
  markdown: string;
  /** Titles offered when a `[[link` is being typed. */
  linkTitles: string[];
  onChange: (markdown: string) => void;
  onRegenerate: () => void;
  /**
   * The note's AI concept map and its rebuild, for the live mindmap's
   * Concept map view; shared with the right panel.
   */
  concept: MindmapRebuild;
  /**
   * The phone layout: the title and Regenerate live in the surrounding chrome,
   * and there is no room for the mindmap beside the text — it is the Map view.
   */
  compact?: boolean;
  /**
   * Someone else holds the edit lock, or the caller may only read (D-17):
   * the text cannot be changed and Regenerate is off.
   */
  readOnly?: boolean;
  /** Read-only only while the edit lock's status loads; see MarkdownEditor. */
  pending?: boolean;
  /** Opens the note a followed `[[wikilink]]` names. */
  onOpenNote?: (title: string) => void;
  /** The editor's caret and selection counts, for the status bar. */
  onStats?: (stats: EditorStats) => void;
  /** Shown between the tab strip and the editor, e.g. "<name> is editing". */
  banner?: ReactNode;
  /** The line under the note's title heading (DOQ-36); see MarkdownEditor. */
  headingNotice?: HeadingNotice | null;
  onDismissHeadingNotice?: () => void;
  /** The caret moved off the note's title line (DOQ-36). */
  onLeaveTitleLine?: () => void;
  /** The editor put the note's title line in (D-120); see MarkdownEditor. */
  onTitleLine?: (markdown: string) => void;
  /** Whether, and with which title, the title line may be added with the first edit; see MarkdownEditor. */
  titleLineWrite?: { safety: TitleLineSafety; title: string | null };
}) {
  const mindmapShown = useSyncExternalStore(subscribeMindmapShown, readMindmapShown, () => true);
  const showMindmap = !compact && mindmapShown;

  const editor = (
    <MarkdownEditor
      value={markdown}
      onChange={onChange}
      linkTitles={linkTitles}
      readOnly={readOnly}
      pending={pending}
      placeholder={PLACEHOLDER}
      compact={compact}
      onOpenNote={onOpenNote}
      onStats={onStats}
      headingNotice={headingNotice}
      onDismissHeadingNotice={onDismissHeadingNotice}
      onLeaveTitleLine={onLeaveTitleLine}
      title={title}
      onTitleLine={onTitleLine}
      titleLineWrite={titleLineWrite}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        A tab strip for the open note. Multi-note tab sessions are not part of
        v1 — the explorer and ⌘K are the navigation model.
      */}
      {compact ? null : (
        <div className="border-border bg-background flex h-11 shrink-0 items-center justify-between gap-2 border-b px-2">
          <Tabs value="active" className="min-w-0">
            {/* The open note as a raised pill in a segmented glass strip. */}
            <TabsList className="h-8">
              <TabsTrigger
                value="active"
                className="text-muted-foreground max-w-[280px] gap-1.5 px-3 text-[13px]"
              >
                <FileTextIcon className="size-3.5 shrink-0 opacity-70" strokeWidth={1.5} />
                <span className="truncate">{title}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={mindmapShown ? "Hide mindmap" : "Show mindmap"}
                    aria-pressed={mindmapShown}
                    onClick={() => setMindmapShown(!mindmapShown)}
                    className={cn(
                      "focus-visible:ring-ring flex size-7 items-center justify-center rounded-md transition-colors duration-150 focus-visible:ring-1 focus-visible:outline-hidden pointer-coarse:size-11",
                      mindmapShown
                        ? "text-foreground bg-[var(--glass-strong)] shadow-[inset_0_1px_0_0_var(--glass-hi)]"
                        : "text-muted-foreground hover:text-foreground hover:bg-[var(--glass-strong)]",
                    )}
                  />
                }
              >
                <NetworkIcon className="size-3.5" strokeWidth={1.75} />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {mindmapShown ? "Hide the live mindmap" : "Show the live mindmap beside the note"}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onRegenerate}
                    disabled={readOnly}
                    // The muted lavender is reserved for AI-driven affordances,
                    // and only tints the icon.
                    className="h-7 gap-1.5 px-2.5 text-[12px]"
                  >
                    <SparklesIcon className="text-accent size-3.5" strokeWidth={1.5} />
                    Regenerate
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                Rewrite this note&apos;s structure and links with AI
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {banner}

      {compact ? (
        <div className="min-h-0 flex-1">{editor}</div>
      ) : (
        /*
          One group whether or not the mindmap shows, so hiding it never
          remounts the editor (and loses its caret and undo history). The
          canvas is unmounted when hidden, which stops its simulation.
        */
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel id="note-text" minSize={300} className="flex min-h-0 flex-col">
            {editor}
          </ResizablePanel>
          {showMindmap && (
            <>
              <ResizableHandle className="hover:bg-foreground/25 transition-colors" />
              <ResizablePanel
                id="note-mindmap"
                defaultSize="42%"
                minSize={220}
                className="flex min-h-0 flex-col"
              >
                <LiveMindmapPane
                  title={title}
                  markdown={markdown}
                  concept={concept}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      )}
    </div>
  );
}
