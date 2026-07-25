"use client";

import dynamic from "next/dynamic";
import { FileTextIcon, SparklesIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Touches `window`, so it must never be server-rendered.
const MDEditor = dynamic(() => import("@uiw/react-md-editor"), {
  ssr: false,
  loading: () => (
    <div className="text-label flex h-full items-center justify-center text-[12px]">
      Loading editor…
    </div>
  ),
});

export function EditorPane({
  title,
  markdown,
  onChange,
  onRegenerate,
}: {
  title: string;
  markdown: string;
  onChange: (markdown: string) => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        A tab strip for the open note. Multi-note tab sessions are not part of
        v1 — the explorer and ⌘K are the navigation model.
      */}
      <div className="border-border bg-background flex h-9 shrink-0 items-center justify-between gap-2 border-b pr-2">
        <Tabs value="active" className="min-w-0">
          <TabsList variant="line" className="h-9 border-0 bg-transparent">
            <TabsTrigger
              value="active"
              // The active tab underline is one of the four places the single
              // accent is allowed to appear.
              className="data-active:text-foreground text-muted-foreground max-w-[280px] gap-1.5 px-3 text-[13px] after:bg-primary!"
            >
              <FileTextIcon className="size-3.5 shrink-0 opacity-60" strokeWidth={1.75} />
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
                // Purple is reserved for AI-driven affordances.
                className="text-accent hover:text-accent hover:bg-accent/10 h-7 gap-1.5 px-2 text-[12px]"
              >
                <SparklesIcon className="size-3.5" strokeWidth={1.75} />
                Regenerate
              </Button>
            }
          />
          <TooltipContent side="bottom">
            Rewrite this note&apos;s structure and links with AI
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1" data-color-mode="dark">
        <MDEditor
          value={markdown}
          onChange={(next) => onChange(next ?? "")}
          height="100%"
          preview="live"
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
