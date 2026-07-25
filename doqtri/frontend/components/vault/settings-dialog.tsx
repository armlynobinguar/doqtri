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

  async function signOut() {
    setBusy(true);
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
            This vault is private to your account.
          </DialogDescription>
        </DialogHeader>

        <dl className="flex flex-col gap-2 text-[13px]">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Signed in as</dt>
            <dd className="truncate">{email}</dd>
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
            Sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
