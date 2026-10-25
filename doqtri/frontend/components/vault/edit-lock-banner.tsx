"use client";

import { LockIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EDITING_ELSEWHERE, editingMessage } from "@/lib/doc-lock";
import type { DocLockState } from "@/lib/doc-lock-client";

/**
 * The strip above the editor that says why it is read-only (WP-1.6, D-17):
 * someone else holds the edit lock, the caller holds it in another tab (or
 * one just closed or reloaded whose release never arrived), the caller is a
 * viewer, or a save was refused because the note changed
 * elsewhere. Renders nothing while the caller can edit.
 */
export function EditLockBanner({
  lock,
  conflict,
  onTakeOver,
  onReload,
}: {
  lock: DocLockState;
  conflict: boolean;
  onTakeOver: () => void;
  onReload: () => void;
}) {
  if (conflict) {
    return (
      <div
        role="status"
        data-testid="edit-conflict-banner"
        className="border-border bg-background text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[12px]"
      >
        <RefreshCwIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          This note was changed elsewhere since you loaded it, so your last edit was not saved.
          Copy anything you want to keep, then reload.
        </span>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2.5 text-[12px]" onClick={onReload}>
          Reload
        </Button>
      </div>
    );
  }

  if (lock.phase === "elsewhere") {
    return (
      <div
        role="status"
        data-testid="edit-lock-elsewhere-banner"
        className="border-border bg-background text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[12px]"
      >
        <LockIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          <span className="text-foreground">{EDITING_ELSEWHERE} (or one you just closed).</span> This
          copy is read-only; it updates when that one saves.
        </span>
        {lock.canEdit ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-[12px]"
            title="Edit here instead. The other tab becomes read-only, and anything it has not saved yet is lost."
            onClick={onTakeOver}
          >
            Edit here
          </Button>
        ) : null}
      </div>
    );
  }

  if (lock.phase === "other") {
    return (
      <div
        role="status"
        data-testid="edit-lock-banner"
        className="border-border bg-background text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[12px]"
      >
        <LockIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          <span className="text-foreground">{editingMessage(lock.holderName)}.</span> You are viewing a
          read-only copy; it updates when they save.
        </span>
        {lock.canTakeOver ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-[12px]"
            title="Take the edit lock from them. Anything they typed in the last moment and did not save is lost."
            onClick={onTakeOver}
          >
            Take over
          </Button>
        ) : null}
      </div>
    );
  }

  if (lock.phase !== "loading" && !lock.canEdit) {
    return (
      <div
        role="status"
        data-testid="read-only-banner"
        className="border-border bg-background text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[12px]"
      >
        <LockIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
        <span>You can read this note but not edit it.</span>
      </div>
    );
  }

  return null;
}
