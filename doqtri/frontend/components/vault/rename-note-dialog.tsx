"use client";

import { useState } from "react";
import { Loader2Icon, PencilIcon } from "lucide-react";
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
 * current title instead of the last one typed.
 *
 * A refusal (usually a title another note already has) stays in the dialog,
 * next to the field the user has to change.
 */
export function RenameNoteDialog({
  open,
  title,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (title: string) => Promise<void>;
}) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const unchanged = trimmed === title;

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || busy) return;
    if (unchanged) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(trimmed);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename note");
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
              disabled={busy}
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
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !trimmed}>
              {busy ? (
                <>
                  <Loader2Icon className="animate-spin" />
                  Renaming…
                </>
              ) : (
                "Rename"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
