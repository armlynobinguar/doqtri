"use client";

import { useState } from "react";
import { KeyRoundIcon, Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWallet } from "@/components/vault/wallet-provider";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The passkeys that can open an email account's wallet. Adding one needs an
 * existing passkey to approve it; the last one can never be removed.
 */
export function PasskeysDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const wallet = useWallet();
  const passkeys = wallet.identity.kind === "email" ? (wallet.identity.smartWallet?.passkeys ?? []) : [];
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const busy = adding || removing !== null;

  async function add() {
    setAdding(true);
    try {
      await wallet.addPasskey();
      toast.success("Passkey added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The passkey could not be added.");
    } finally {
      setAdding(false);
    }
  }

  async function remove(credentialId: string) {
    setRemoving(credentialId);
    try {
      await wallet.removePasskey(credentialId);
      toast.success("Passkey removed");
      setConfirming(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The passkey could not be removed.");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Passkeys</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Any of these opens your wallet. If you lose every one, the wallet can&apos;t be recovered.
          </DialogDescription>
        </DialogHeader>

        <ul className="divide-border flex flex-col divide-y rounded-lg border text-[13px]" data-testid="passkey-list">
          {passkeys.map((passkey) => (
            <li key={passkey.credentialId} className="grid gap-2 px-3 py-2.5">
              <div className="flex items-center gap-2.5">
                <KeyRoundIcon className="text-muted-foreground size-4 shrink-0" />
                <div className="grid min-w-0 flex-1">
                  {/* Identified by its credential id: positions shift when one is removed. */}
                  <span className="font-medium">
                    Passkey <span className="font-mono">{passkey.credentialId.slice(0, 8)}</span>
                  </span>
                  <span className="text-muted-foreground truncate text-[12px]">
                    Added {formatDate(passkey.createdAt)}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove passkey ${passkey.credentialId.slice(0, 8)}`}
                  disabled={busy || passkeys.length <= 1}
                  title={passkeys.length <= 1 ? "Your only passkey can't be removed" : undefined}
                  onClick={() => setConfirming(passkey.credentialId)}
                >
                  <Trash2Icon />
                </Button>
              </div>
              {confirming === passkey.credentialId ? (
                <div className="bg-destructive/5 border-destructive/30 grid gap-2 rounded-md border px-2.5 py-2 text-[12px]">
                  <span>
                    Remove this passkey? It will no longer open your wallet. You&apos;ll approve the change with a passkey.
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={removing !== null}
                      onClick={() => void remove(passkey.credentialId)}
                    >
                      {removing === passkey.credentialId ? <Loader2Icon className="animate-spin" /> : null}
                      Remove
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={removing !== null}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        <p className="text-muted-foreground text-[12px] leading-relaxed">
          A passkey saved in iCloud Keychain or Google Password Manager is already copied to that account&apos;s
          devices. For a real backup, add one somewhere else: a phone on the other platform, a second computer, or
          a security key. When the browser asks where to save it, choose that device.
        </p>

        <Button type="button" disabled={busy} onClick={() => void add()} data-testid="add-passkey">
          {adding ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
          {adding ? "Adding passkey…" : "Add a passkey"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
