"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2Icon, ImagePlusIcon, Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  MINDMAP_PROMO,
  PROMO_BUCKET,
  PROMO_IMAGE_TYPES,
  promoFilesProblem,
  type PromoSubmission,
} from "@/lib/promo";
import { cn } from "@/lib/utils";

type Picked = { file: File; preview: string };

const ACCEPT = Object.keys(PROMO_IMAGE_TYPES).join(",");

export function PromoSubmissionForm({ submission }: { submission: PromoSubmission | null }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [caption, setCaption] = useState(submission?.caption ?? "");
  const [contact, setContact] = useState(submission?.contact ?? "");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const room = MINDMAP_PROMO.maxImages - picked.length;

  function add(files: Iterable<File>) {
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    const problem = promoFilesProblem(images);
    if (problem && !problem.startsWith("Attach up to")) {
      toast.error(problem);
      return;
    }
    if (images.length > room) {
      toast.error(`Attach up to ${MINDMAP_PROMO.maxImages} screenshots.`);
    }
    const accepted = images
      .slice(0, Math.max(room, 0))
      .map((file) => ({ file, preview: URL.createObjectURL(file) }));
    setPicked((current) => [...current, ...accepted]);
  }

  function removeAt(index: number) {
    setPicked((current) => {
      URL.revokeObjectURL(current[index].preview);
      return current.filter((_, i) => i !== index);
    });
  }

  // Screenshots usually sit on the clipboard; let a paste attach them.
  const onPaste = useEffectEvent((event: ClipboardEvent) => {
    const files = event.clipboardData?.files;
    if (files?.length) add(files);
  });
  useEffect(() => {
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const files = picked.map((p) => p.file);
    const problem = promoFilesProblem(files);
    if (problem) {
      toast.error(problem);
      return;
    }

    setBusy(true);
    try {
      const minted = await postJson<{
        uploadId: string;
        uploads: { path: string; token: string }[];
      }>("/api/promo/uploads", {
        files: files.map((file) => ({ type: file.type, size: file.size })),
      });

      const storage = createSupabaseBrowserClient().storage.from(PROMO_BUCKET);
      await Promise.all(
        minted.uploads.map(async ({ path, token }, i) => {
          const { error } = await storage.uploadToSignedUrl(path, token, files[i], {
            contentType: files[i].type,
          });
          if (error) throw new Error(`Upload failed: ${error.message}`);
        }),
      );

      await postJson("/api/promo/submissions", {
        uploadId: minted.uploadId,
        paths: minted.uploads.map((u) => u.path),
        caption,
        contact,
      });

      for (const p of picked) URL.revokeObjectURL(p.preview);
      setPicked([]);
      toast.success(submission ? "Entry updated" : "You're in! Good luck.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Submission failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {submission && (
        <div className="glass rounded-2xl p-4">
          <p className="text-foreground flex items-center gap-2 text-[13px] font-medium">
            <CheckCircle2Icon className="text-success size-4" />
            Entry received{" "}
            {new Date(submission.updatedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </p>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {submission.imageUrls.map((url) => (
              // Signed, short-lived URLs: next/image would cache them past expiry.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={url}
                alt="Submitted screenshot"
                className="aspect-video w-full rounded-lg border border-[var(--glass-lo)] object-cover"
              />
            ))}
          </div>
          <p className="text-muted-foreground mt-3 text-[12px]">
            Submit again below to replace this entry.
          </p>
        </div>
      )}

      <div>
        <label className="eyebrow text-foreground/80 leading-relaxed" htmlFor="promo-files">
          Screenshots{" "}
          <span className="text-label font-normal">
            ({picked.length}/{MINDMAP_PROMO.maxImages})
          </span>
        </label>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            add(event.dataTransfer.files);
          }}
          className={cn(
            "mt-3 grid grid-cols-2 gap-2 rounded-2xl border border-dashed border-[var(--glass-hi)] bg-black/20 p-2 sm:grid-cols-4",
            dragging && "border-foreground/60 bg-[var(--glass-strong)]",
          )}
        >
          {picked.map((p, i) => (
            <div key={p.preview} className="relative">
              {/* Local object URL preview. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.preview}
                alt={p.file.name}
                className="aspect-video w-full rounded-lg border border-[var(--glass-lo)] object-cover"
              />
              <button
                type="button"
                onClick={() => removeAt(i)}
                disabled={busy}
                aria-label={`Remove ${p.file.name}`}
                className="bg-background/80 hover:bg-background absolute top-1 right-1 flex size-6 items-center justify-center rounded-full border"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
          {room > 0 && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground flex aspect-video flex-col items-center justify-center gap-1 rounded-lg text-[12px] transition-colors hover:bg-[var(--glass-strong)]"
            >
              <ImagePlusIcon className="size-5" strokeWidth={1.5} />
              Add screenshot
            </button>
          )}
        </div>
        <p className="text-label mt-1.5 text-[12px]">
          PNG, JPEG or WebP, up to {MINDMAP_PROMO.maxImageBytes / 1024 / 1024} MB each.
          Drop files here or paste from the clipboard.
        </p>
        <input
          ref={inputRef}
          id="promo-files"
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) add(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      <div>
        <label className="eyebrow text-foreground/80 leading-relaxed" htmlFor="promo-caption">
          What does it map? <span className="text-label font-normal">(optional)</span>
        </label>
        <Textarea
          id="promo-caption"
          className="mt-3"
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          maxLength={MINDMAP_PROMO.maxCaption}
          placeholder="A DeFi explainer, a Stellar launch plan, a Web3 thesis…"
        />
      </div>

      <div>
        <label className="eyebrow text-foreground/80 leading-relaxed" htmlFor="promo-contact">
          How do we reach you if you win?{" "}
          <span className="text-label font-normal">(optional)</span>
        </label>
        <Input
          id="promo-contact"
          className="mt-3"
          value={contact}
          onChange={(event) => setContact(event.target.value)}
          maxLength={MINDMAP_PROMO.maxContact}
          placeholder="Email or X handle"
        />
      </div>

      <Button type="submit" size="lg" disabled={busy || picked.length === 0} className="self-start rounded-full">
        {busy && <Loader2Icon className="animate-spin" />}
        {submission ? "Replace entry" : "Submit entry"}
      </Button>
    </form>
  );
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  return data as T;
}
