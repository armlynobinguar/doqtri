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
import type { VaultIdentity } from "@/lib/types";

export function SettingsDialog({
  identity,
  noteCount,
  open,
  onOpenChange,
}: {
  identity: VaultIdentity;
  noteCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const wallet = identity.kind === "wallet";
  const full = wallet ? identity.address : identity.email;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {wallet
              ? "This vault is private to your connected wallet."
              : "This vault is private to your email account."}
          </DialogDescription>
        </DialogHeader>

        <dl className="flex flex-col gap-2 text-[13px]">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{wallet ? "Wallet" : "Email"}</dt>
            <dd className={wallet ? "truncate font-mono" : "truncate"} title={full}>
              {wallet ? shortenAddress(full) : full}
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
            <dd>Doqtri Dark</dd>
          </div>
        </dl>

        <p className="text-muted-foreground text-[12px]">
          {wallet
            ? "Balance, reconnect, and disconnect are in the account menu at the bottom right of the status bar."
            : "Sign out is in the account menu at the bottom right of the status bar."}
        </p>
      </DialogContent>
    </Dialog>
  );
}
