"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { shortenAddress } from "@/lib/wallet";

export function SettingsDialog({
  email,
  noteCount,
  open,
  onOpenChange,
}: {
  email: string;
  noteCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const identity = email.startsWith("G") ? shortenAddress(email) : email;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            This vault is private to your connected wallet.
          </DialogDescription>
        </DialogHeader>

        <dl className="flex flex-col gap-2 text-[13px]">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Wallet</dt>
            <dd className="truncate font-mono" title={email}>
              {identity}
            </dd>
          </div>
          <Separator />
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="tabular-nums">{noteCount}</dd>
          </div>
          <Separator />
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Theme</dt>
            <dd>Cursor Dark</dd>
          </div>
        </dl>

        <p className="text-muted-foreground text-[12px]">
          Balance, reconnect, and disconnect are in the account menu at the
          bottom right of the status bar.
        </p>
      </DialogContent>
    </Dialog>
  );
}
