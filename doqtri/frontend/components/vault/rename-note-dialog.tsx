"use client";

import { useState } from "react";
import { PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MAX_TITLE_LENGTH } from "@/lib/title";

/**
 * Renames a note. Only the title changes — the note's text, and so an
 * anchored note's content hash, stay as they are. The title is what other
 * notes' [[wikilinks]] resolve against, so the dialog says those links will
 * stop resolving rather than letting the graph quietly lose edges.
 *
 * Mount it with a `key` per note, so each opening starts from that note's
 * current title (or `initialValue`, when a refused rename is retried) instead
 * of the last one typed.
 *
 * The rename is optimistic: `onConfirm` starts it and returns, and the dialog
 * closes in the same frame the new title appears. A refusal the client can
 * see coming (a title another note already has) is thrown by `onConfirm`
 * instead and stays in the dialog, next to the field the user has to change.
 */
export function RenameNoteDialog({
  open,
  title,
  initialValue,
  onOpenChange,
  onConfirm,
  finalFocus,
}: {
  open: boolean;
  title: string;
  initialValue?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (title: string) => void;
  /** Where focus goes when the dialog closes; see Base UI's Dialog.Popup. */
  finalFocus?: () => HTMLElement | boolean;
}) {
  const [value, setValue] = useState(initialValue ?? title);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const unchanged = trimmed === title;

  function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed) return;
    if (unchanged) {
      onOpenChange(false);
      return;
    }
    try {
      onConfirm(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename note");
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]" finalFocus={finalFocus}>
        <form onSubmit={confirm} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PencilIcon className="text-foreground size-4" strokeWidth={1.5} />
              Rename note
            </DialogTitle>
            <DialogDescription className="text-muted-foreground leading-relaxed">
              Other notes that link to{" "}
              <code className="text-foreground font-mono text-[12px]">
                [[{title}]]
              </code>{" "}
              keep that link, which becomes unresolved. The note&apos;s text is
              not changed, so an anchored note stays verified.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Input
              aria-label="Note title"
              autoFocus
              value={value}
              maxLength={MAX_TITLE_LENGTH}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              onFocus={(event) => event.target.select()}
            />
            {error ? (
              <p role="alert" className="text-destructive text-[12px]">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
