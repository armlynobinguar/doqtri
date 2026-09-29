"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  CircleIcon,
  Loader2Icon,
  MinusIcon,
  RotateCcwIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
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
import { INGEST_ERRORS, type IngestErrorCode } from "@/lib/ingest/errors";
import { INGEST_STAGES, STAGE_LABELS, type IngestStage } from "@/lib/ingest/events";
import { runIngestRequest } from "@/lib/ingest/client";
import { cn } from "@/lib/utils";

const ACCEPT = ".pdf,.docx,.pptx,.txt,.md";

type StageStatus = "pending" | "active" | "done" | "skipped" | "failed";

type Failure = {
  code: IngestErrorCode;
  message: string;
  ingestId: string | null;
};

/** A failed import to re-run from its archived original, from the explorer. */
export type RetryTarget = { ingestId: string; filename: string };

function initialStages(): Record<IngestStage, StageStatus> {
  return Object.fromEntries(INGEST_STAGES.map((s) => [s, "pending"])) as Record<
    IngestStage,
    StageStatus
  >;
}

export function UploadDialog({
  open,
  onOpenChange,
  retry = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  retry?: RetryTarget | null;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState(initialStages);
  const [failure, setFailure] = useState<Failure | null>(null);
  const startedRetry = useRef<string | null>(null);

  const running = busy || failure !== null;

  function reset() {
    setFile(null);
    setFilename(null);
    setBusy(false);
    setStages(initialStages());
    setFailure(null);
    startedRetry.current = null;
  }

  function close() {
    const hadFailure = failure !== null;
    reset();
    onOpenChange(false);
    // A failure leaves a retryable row behind; let the explorer pick it up.
    if (hadFailure) router.refresh();
  }

  async function run(name: string, request: () => Promise<Response>) {
    setFilename(name);
    setBusy(true);
    setFailure(null);
    setStages(initialStages());

    const outcome = await runIngestRequest(request(), (event) => {
      if (event.type === "stage") {
        setStages((prev) => ({ ...prev, [event.stage]: event.status }));
      }
    });

    setBusy(false);

    if (!outcome.ok) {
      if (outcome.stage) {
        const failedStage = outcome.stage;
        setStages((prev) => ({ ...prev, [failedStage]: "failed" }));
      }
      setFailure({ code: outcome.code, message: outcome.message, ingestId: outcome.ingestId });
      return;
    }

    // Navigate only once the note exists, so a failure can never land the
    // user on an empty vault.
    if (outcome.mindmapped) {
      toast.success(`Converted “${name}”`);
    } else {
      toast.warning(`Converted “${name}” — mindmap could not be built`);
    }
    reset();
    onOpenChange(false);
    router.refresh();
    router.push(`/vault/${outcome.id}`);
  }

  function upload() {
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    void run(file.name, () => fetch("/api/ingest", { method: "POST", body }));
  }

  function retryIngest(ingestId: string, name: string, raw = false) {
    void run(name, () =>
      fetch("/api/ingest/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingestId, raw }),
      }),
    );
  }

  // Opened from a failed import in the explorer: start straight away.
  useEffect(() => {
    if (!open || !retry || startedRetry.current === retry.ingestId) return;
    startedRetry.current = retry.ingestId;
    retryIngest(retry.ingestId, retry.filename);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per target
  }, [open, retry]);

  const copy = failure ? INGEST_ERRORS[failure.code] : null;
  const isPdf = /\.pdf$/i.test(filename ?? "");

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
          <DialogTitle>{running ? `Importing “${filename}”` : "Upload document"}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {running ? (
              "Each step is shown as it runs. The original file is kept, so a failed import can be retried."
            ) : (
              <>
                PDF, DOCX, PPTX, or text. The document is converted to markdown with
                headings and{" "}
                <code className="text-primary font-mono text-[12px]">[[wikilinks]]</code>
                , which you then own and edit, and a mindmap of its concepts is built
                at the same time.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {running ? (
          <ol className="grid gap-1.5 text-[13px]" aria-label="Import progress">
            {INGEST_STAGES.map((stage) => (
              <StageRow key={stage} label={STAGE_LABELS[stage]} status={stages[stage]} />
            ))}
          </ol>
        ) : (
          <Input
            type="file"
            accept={ACCEPT}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="file:text-muted-foreground cursor-pointer file:mr-3 file:cursor-pointer"
          />
        )}

        {failure && copy ? (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 grid gap-1 rounded-md border px-3 py-2 text-[13px]"
          >
            <span className="font-medium">{copy.message}</span>
            {failure.message !== copy.message ? (
              <span className="text-muted-foreground text-[12px]">{failure.message}</span>
            ) : null}
            <span className="text-muted-foreground font-mono text-[11px]">{failure.code}</span>
          </div>
        ) : null}

        <DialogFooter>
          {failure ? (
            <>
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
              {copy?.rawFallback && failure.ingestId && !isPdf ? (
                <Button
                  variant="secondary"
                  onClick={() => retryIngest(failure.ingestId!, filename ?? "document", true)}
                >
                  Import without AI formatting
                </Button>
              ) : null}
              {copy?.retryable && failure.ingestId ? (
                <Button onClick={() => retryIngest(failure.ingestId!, filename ?? "document")}>
                  <RotateCcwIcon />
                  Retry
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={upload} disabled={!file || busy}>
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
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StageRow({ label, status }: { label: string; status: StageStatus }) {
  const icon = {
    pending: <CircleIcon className="size-3.5 opacity-40" />,
    active: <Loader2Icon className="text-primary size-3.5 animate-spin" />,
    done: <CheckIcon className="text-primary size-3.5" />,
    skipped: <MinusIcon className="size-3.5 opacity-60" />,
    failed: <XIcon className="text-destructive size-3.5" />,
  }[status];

  return (
    <li
      data-status={status}
      className={cn(
        "flex items-center gap-2",
        status === "pending" && "text-muted-foreground",
        status === "failed" && "text-destructive",
      )}
    >
      {icon}
      <span>{label}</span>
      {status === "skipped" ? (
        <span className="text-muted-foreground ml-auto text-[11px]">skipped</span>
      ) : null}
    </li>
  );
}
