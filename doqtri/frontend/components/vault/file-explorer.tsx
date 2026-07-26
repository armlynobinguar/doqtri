"use client";

import Link from "next/link";
import {
  FileTextIcon,
  ChevronDownIcon,
  UploadIcon,
  FilePlusIcon,
  Loader2Icon,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { NoteSummary } from "@/lib/types";

/**
 * Flat vault listing under a single root. The schema is one table with no
 * folder column, so there is no hierarchy to render — inventing one would
 * mean a second table, which the spec defers to v2.
 */
export function FileExplorer({
  notes,
  activeId,
  onNewNote,
  onUploadClick,
  creating = false,
}: {
  notes: NoteSummary[];
  activeId?: string;
  onNewNote: () => void;
  onUploadClick: () => void;
  creating?: boolean;
}) {
  return (
    <aside className="bg-sidebar flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between gap-1 pr-1 pl-3">
        <span className="text-label text-[11px] font-medium tracking-wider uppercase">
          Vault
        </span>
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger
              aria-label="New note"
              disabled={creating}
              onClick={onNewNote}
              className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-7 items-center justify-center rounded-md transition-colors focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden disabled:opacity-50"
            >
              {creating ? (
                <Loader2Icon className="size-4 animate-spin" strokeWidth={1.75} />
              ) : (
                <FilePlusIcon className="size-4" strokeWidth={1.75} />
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom">New note  ⌘N</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              aria-label="Upload document"
              onClick={onUploadClick}
              className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-7 items-center justify-center rounded-md transition-colors focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden"
            >
              <UploadIcon className="size-4" strokeWidth={1.75} />
            </TooltipTrigger>
            <TooltipContent side="bottom">Upload document</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-4">
          <div className="text-sidebar-foreground/80 flex items-center gap-1 px-2 py-1 text-[13px]">
            <ChevronDownIcon className="size-3.5 shrink-0" strokeWidth={2} />
            <span className="truncate">Notes</span>
            <span className="text-label ml-auto pr-1 text-[11px] tabular-nums">
              {notes.length}
            </span>
          </div>

          {notes.length === 0 ? (
            <p className="text-label px-3 py-2 text-[12px] leading-relaxed">
              No notes yet. Create a note or upload a document.
            </p>
          ) : (
            <ul>
              {notes.map((note) => {
                const isActive = note.id === activeId;
                return (
                  <li key={note.id}>
                    <Link
                      href={`/vault/${note.id}`}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "group flex items-center gap-1.5 border-l-2 py-[5px] pr-2 pl-4 text-[13px] transition-colors",
                        isActive
                          ? "border-l-primary bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground border-l-transparent",
                      )}
                    >
                      <FileTextIcon
                        className="size-3.5 shrink-0 opacity-60"
                        strokeWidth={1.75}
                      />
                      <span className="truncate">{note.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
