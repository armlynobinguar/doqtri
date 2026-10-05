"use client";

import Link from "next/link";
import {
  FileTextIcon,
  ChevronDownIcon,
  LinkIcon,
  UploadIcon,
  FilePlusIcon,
  Loader2Icon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StatusTag } from "@/components/ui/status-tag";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { RetryTarget } from "@/components/vault/upload-dialog";
import type { FailedImport, NoteSummary } from "@/lib/types";

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
  failedImports = [],
  onRetryImport,
  anchoredIds,
  onDeleteNote,
  deletingId,
}: {
  notes: NoteSummary[];
  activeId?: string;
  onNewNote: () => void;
  onUploadClick: () => void;
  creating?: boolean;
  failedImports?: FailedImport[];
  onRetryImport?: (target: RetryTarget) => void;
  /** Notes with a record on the ledger. Those cannot be deleted. */
  anchoredIds?: ReadonlySet<string>;
  onDeleteNote?: (note: NoteSummary) => void;
  deletingId?: string | null;
}) {
  return (
    <aside className="bg-sidebar flex h-full min-h-0 flex-col">
      <header className="border-border flex h-10 shrink-0 items-center justify-between gap-1 border-b pr-1.5 pl-3">
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
                const anchored = anchoredIds?.has(note.id) ?? false;
                return (
                  <li
                    key={note.id}
                    className={cn(
                      "group mx-1.5 flex items-center rounded-md pr-1 text-[13px] transition-colors",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                    )}
                  >
                    <Link
                      href={`/vault/${note.id}`}
                      aria-current={isActive ? "page" : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2 py-[5px] pl-2.5"
                    >
                      <FileTextIcon
                        className={cn("size-3.5 shrink-0", isActive ? "text-primary" : "opacity-60")}
                        strokeWidth={1.75}
                      />
                      <span className="truncate">{note.title}</span>
                    </Link>
                    <NoteRowAction
                      note={note}
                      anchored={anchored}
                      deleting={deletingId === note.id}
                      onDelete={onDeleteNote}
                    />
                  </li>
                );
              })}
            </ul>
          )}

          {failedImports.length > 0 && onRetryImport ? (
            <FailedImports items={failedImports} onRetry={onRetryImport} />
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

/**
 * Imports that never became notes. The original file is still archived, so
 * each one can be re-run without finding the file again, or dismissed.
 */
function FailedImports({
  items,
  onRetry,
}: {
  items: FailedImport[];
  onRetry: (target: RetryTarget) => void;
}) {
  const router = useRouter();

  async function dismiss(id: string) {
    // RLS allows the owner to delete their own ingest rows.
    const { error } = await createSupabaseBrowserClient().from("ingests").delete().eq("id", id);
    if (error) toast.error(error.message);
    router.refresh();
  }

  return (
    <div className="mt-3">
      <div className="text-sidebar-foreground/80 flex items-center gap-1 px-2 py-1 text-[13px]">
        <TriangleAlertIcon className="text-destructive size-3.5 shrink-0" strokeWidth={2} />
        <span className="truncate">Failed imports</span>
        <span className="text-label ml-auto pr-1 text-[11px] tabular-nums">{items.length}</span>
      </div>
      <ul>
        {items.map((item) => (
          <li
            key={item.id}
            className="text-sidebar-foreground flex items-center gap-1 py-[3px] pr-1 pl-4 text-[13px]"
          >
            <span className="min-w-0 flex-1 truncate" title={item.error_code ?? "Interrupted"}>
              {item.filename}
            </span>
            <button
              type="button"
              aria-label={`Retry import of ${item.filename}`}
              onClick={() => onRetry({ ingestId: item.id, filename: item.filename })}
              className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-md"
            >
              <RotateCcwIcon className="size-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label={`Dismiss failed import of ${item.filename}`}
              onClick={() => void dismiss(item.id)}
              className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-md"
            >
              <XIcon className="size-3.5" strokeWidth={1.75} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The trailing control on a note row: delete, or — for a note that is anchored
 * — a greyed-out chain in its place.
 *
 * The registry contract has no delete, so an anchored note's ledger entry and
 * its public /d/[docId] page outlive anything this app could remove. Showing a
 * disabled marker says that, where hiding the button would read as a bug and
 * an enabled one would promise an erasure that cannot happen.
 */
function NoteRowAction({
  note,
  anchored,
  deleting,
  onDelete,
}: {
  note: NoteSummary;
  anchored: boolean;
  deleting: boolean;
  onDelete?: (note: NoteSummary) => void;
}) {
  if (anchored) {
    return (
      <Tooltip>
        {/* A span, not a disabled button: a disabled button swallows the
            hover that opens the tooltip explaining why it is disabled. */}
        <TooltipTrigger
          render={<span />}
          role="img"
          aria-label={`${note.title} is anchored on Stellar and cannot be deleted`}
          className="flex shrink-0 items-center"
        >
          <StatusTag tone="onchain" className="px-1.5 py-[3px] text-[10px]">
            <LinkIcon strokeWidth={2} />
            On-chain
          </StatusTag>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[260px]">
          Anchored on Stellar. The on-chain record cannot be deleted, so this
          note stays with it.
        </TooltipContent>
      </Tooltip>
    );
  }

  if (!onDelete) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`Delete ${note.title}`}
        disabled={deleting}
        onClick={() => onDelete(note)}
        className="text-sidebar-foreground/70 hover:text-destructive hover:bg-sidebar-accent focus-visible:ring-ring flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:outline-hidden disabled:opacity-100"
      >
        {deleting ? (
          <Loader2Icon className="size-3.5 animate-spin" strokeWidth={1.75} />
        ) : (
          <Trash2Icon className="size-3.5" strokeWidth={1.75} />
        )}
      </TooltipTrigger>
      <TooltipContent side="right">Delete note</TooltipContent>
    </Tooltip>
  );
}
