"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { disconnectWallet, shortenAddress } from "@/lib/wallet";

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
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const identity = email.startsWith("G") ? shortenAddress(email) : email;

  async function signOut() {
    setBusy(true);
    try {
      await disconnectWallet();
    } catch {
      // wallet may already be disconnected
    }
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.refresh();
    router.push("/login");
  }

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

        <DialogFooter>
          <Button variant="outline" onClick={signOut} disabled={busy}>
            <LogOutIcon />
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
