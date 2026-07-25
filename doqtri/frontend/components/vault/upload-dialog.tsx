"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const ACCEPT = ".pdf,.docx,.pptx,.txt,.md";

export function UploadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setFile(null);
    setBusy(false);
    onOpenChange(false);
  }

  async function handleUpload() {
    if (!file) return;
    setBusy(true);

    const body = new FormData();
    body.append("file", file);

    try {
      const res = await fetch("/api/ingest", { method: "POST", body });
      const payload: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : `Ingest failed (${res.status})`;
        throw new Error(message);
      }

      const id =
        payload && typeof payload === "object" && "id" in payload
          ? String((payload as { id: unknown }).id)
          : null;
      if (!id) throw new Error("Ingest returned no document id");

      toast.success(`Converted “${file.name}”`);
      close();
      router.refresh();
      router.push(`/vault/${id}`);
    } catch (error) {
      setBusy(false);
      toast.error(error instanceof Error ? error.message : "Ingest failed");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // don't drop an in-flight ingest
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            PDF, DOCX, PPTX, or text. The document is converted to markdown with
            headings and{" "}
            <code className="text-primary font-mono text-[12px]">
              [[wikilinks]]
            </code>
            , which you then own and edit.
          </DialogDescription>
        </DialogHeader>

        <Input
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="file:text-muted-foreground cursor-pointer file:mr-3 file:cursor-pointer"
        />

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || busy}>
            {busy ? (
              <>
                <Loader2Icon className="animate-spin" />
                Converting…
              </>
            ) : (
              <>
                <UploadIcon />
                Convert
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
