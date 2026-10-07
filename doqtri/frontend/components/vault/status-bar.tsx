"use client";

import { CheckIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

export function StatusBar({
  noteCount,
  wordCount,
  saveState = "idle",
  trailing,
  className,
}: {
  noteCount: number;
  wordCount?: number;
  saveState?: SaveState;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <footer
      className={cn(
        "bg-sidebar border-border text-label flex h-7 shrink-0 items-center gap-4 border-t px-3 text-[11px] select-none",
        className,
      )}
    >
      <span className="tabular-nums">
        {noteCount} {noteCount === 1 ? "note" : "notes"}
      </span>
      {wordCount !== undefined && (
        <span className="tabular-nums">
          {wordCount} {wordCount === 1 ? "word" : "words"}
        </span>
      )}
      {saveState !== "idle" && (
        <span
          className={
            saveState === "error"
              ? "text-destructive"
              : saveState === "saved"
                ? "text-muted-foreground flex items-center gap-1 [&_svg]:text-success"
                : "flex items-center gap-1"
          }
          role="status"
        >
          {saveState === "saved" ? <CheckIcon className="size-3" strokeWidth={2.25} aria-hidden /> : null}
          {saveState === "saving" ? <Loader2Icon className="size-3 animate-spin" aria-hidden /> : null}
          {SAVE_LABEL[saveState]}
        </span>
      )}
      <span className="ml-auto">Doqtri Dark</span>
      {trailing}
    </footer>
  );
}
