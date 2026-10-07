"use client";

import dynamic from "next/dynamic";
import { FileTextIcon, SparklesIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { DoqtriLoader } from "@/components/brand/doqtri-loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Touches `window`, so it must never be server-rendered.
const MDEditor = dynamic(() => import("@uiw/react-md-editor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <DoqtriLoader className="w-14" />
    </div>
  ),
});

export function EditorPane({
  title,
  markdown,
  onChange,
  onRegenerate,
  compact = false,
}: {
  title: string;
  markdown: string;
  onChange: (markdown: string) => void;
  onRegenerate: () => void;
  /**
   * The phone layout: the title and Regenerate live in the surrounding chrome,
   * and the editor opens on the source alone — a live preview beside it would
   * leave each side a column a few words wide.
   */
  compact?: boolean;
}) {
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

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRegenerate}
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
      )}

      <div className="min-h-0 flex-1" data-color-mode="dark">
        <MDEditor
          value={markdown}
          onChange={(next) => onChange(next ?? "")}
          height="100%"
          preview={compact ? "edit" : "live"}
          visibleDragbar={false}
          textareaProps={{
            placeholder: "Write markdown. Wrap concepts in [[double brackets]].",
            spellCheck: false,
          }}
          style={{ height: "100%" }}
        />
      </div>
    </div>
  );
}
