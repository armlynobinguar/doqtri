"use client";

import { useState } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
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
 * v1 regenerate is a full overwrite, so the confirm dialog is the only thing
 * standing between the user and losing their current version. It must be
 * explicit about that.
 */
export function RegenerateDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
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
            <SparklesIcon className="text-accent size-4" strokeWidth={1.75} />
            Regenerate this note
          </DialogTitle>
          <DialogDescription className="text-muted-foreground leading-relaxed">
            AI will rewrite the heading structure and add{" "}
            <code className="text-primary font-mono text-[12px]">
              [[wikilinks]]
            </code>{" "}
            to your other notes.{" "}
            <strong className="text-foreground font-medium">
              This replaces your current version
            </strong>{" "}
            and cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={confirm}
            disabled={busy}
            className="bg-accent text-accent-foreground hover:bg-accent/90"
          >
            {busy ? (
              <>
                <Loader2Icon className="animate-spin" />
                Regenerating…
              </>
            ) : (
              "Replace my version"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
