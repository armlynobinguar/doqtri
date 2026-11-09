"use client";

import { useEffect, useRef } from "react";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Delete is a hard delete — the note, its mindmap, and the originals archived
 * at import all go, with nothing to restore from. The dialog is the only thing
 * standing between the user and that, so it names what goes.
 *
 * Anchored notes never reach this dialog: the explorer shows a chain icon
 * instead of the delete button, and the API refuses them.
 *
 * The delete is optimistic: `onConfirm` starts it and the dialog closes as
 * the row goes. A refusal brings the row back with a toast.
 */
export function DeleteNoteDialog({
  open,
  title,
  onOpenChange,
  onConfirm,
  focusAfterConfirm,
}: {
  open: boolean;
  title: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /**
   * Where focus goes when the dialog closes after a confirm; null, or a
   * cancel, leaves it to Base UI, which returns it to the trigger.
   */
  focusAfterConfirm?: () => HTMLElement | null;
}) {
  // Whether this opening ended in a delete; reset on each opening.
  const confirmed = useRef(false);
  useEffect(() => {
    if (open) confirmed.current = false;
  }, [open]);

  function confirm() {
    onConfirm();
    confirmed.current = true;
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[440px]"
        finalFocus={() => (confirmed.current ? (focusAfterConfirm?.() ?? true) : true)}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2Icon className="text-destructive size-4" strokeWidth={1.75} />
            Delete “{title}”
          </DialogTitle>
          <DialogDescription className="text-muted-foreground leading-relaxed">
            The note, its mindmap, and any original file archived when it was
            imported are deleted for good.{" "}
            <strong className="text-foreground font-medium">
              This cannot be undone.
            </strong>{" "}
            Other notes that link to it keep their{" "}
            <code className="text-foreground font-mono text-[12px]">
              [[wikilinks]]
            </code>
            , which become unresolved.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={confirm} className="bg-destructive text-white hover:bg-destructive/90">
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
