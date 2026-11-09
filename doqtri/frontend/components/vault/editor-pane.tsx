"use client";

import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import { FileTextIcon, SparklesIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { DoqtriLoader } from "@/components/brand/doqtri-loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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

export function EditorPane({
  title,
  markdown,
  onChange,
  onRegenerate,
  linkTitles,
  compact = false,
  readOnly = false,
  pending = false,
  banner,
}: {
  title: string;
  markdown: string;
  /** Titles offered when a `[[link` is being typed. */
  linkTitles: string[];
  onChange: (markdown: string) => void;
  onRegenerate: () => void;
  /** The phone layout: the title and Regenerate live in the surrounding chrome. */
  compact?: boolean;
  /**
   * Someone else holds the edit lock, or the caller may only read (D-17):
   * the text cannot be changed and Regenerate is off.
   */
  readOnly?: boolean;
  /** Read-only only while the edit lock's status loads; see MarkdownEditor. */
  pending?: boolean;
  /** Shown between the tab strip and the editor, e.g. "<name> is editing". */
  banner?: ReactNode;
}) {
  const editor = (
    <MarkdownEditor
      value={markdown}
      onChange={onChange}
      linkTitles={linkTitles}
      readOnly={readOnly}
      pending={pending}
      placeholder={PLACEHOLDER}
      compact={compact}
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

      <div className="min-h-0 flex-1">{editor}</div>
    </div>
  );
}
