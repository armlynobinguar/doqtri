"use client";

import { useState } from "react";
import { Loader2Icon, Trash2Icon } from "lucide-react";
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
 */
export function DeleteNoteDialog({
  open,
  title,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
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
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={confirm}
            disabled={busy}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {busy ? (
              <>
                <Loader2Icon className="animate-spin" />
                Deleting…
              </>
            ) : (
              "Delete permanently"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
