"use client";

import { FileTextIcon } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { NoteSummary } from "@/lib/types";
import { useNavigate } from "@/components/vault/navigation";

/** Obsidian-style quick switcher. Opened with ⌘K from the shell. */
export function QuickSwitcher({
  notes,
  open,
  onOpenChange,
}: {
  notes: NoteSummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick switcher"
      description="Jump to a note by title"
      // Clear of the on-screen keyboard, which covers the lower half.
      className="max-sm:top-[calc(env(safe-area-inset-top)+0.75rem)]"
    >
      {/*
        CommandDialog only supplies the Dialog shell — it does not wrap children
        in a Command root, so the cmdk context has to be provided here or
        CommandInput has no store to subscribe to.
      */}
      <Command>
        <CommandInput placeholder="Go to note…" shortcut="⌘K" />
        <CommandList>
          <CommandEmpty className="text-muted-foreground">
            No notes found.
          </CommandEmpty>
          <CommandGroup heading="Notes">
            {notes.map((note) => (
              <CommandItem
                key={note.id}
                value={note.title}
                onSelect={() => {
                  onOpenChange(false);
                  navigate(`/vault/${note.id}`);
                }}
              >
                <FileTextIcon className="opacity-60" strokeWidth={1.5} />
                <span className="truncate">{note.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
