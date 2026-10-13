"use client";

import { useMemo, useState } from "react";
import {
  FlagIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { shortAddress, type CommunityTemplate } from "@/lib/market";
import { cn } from "@/lib/utils";

const MAX_REASON = 1000;

/**
 * Report a community template as a copy of another (progress/004, phase 3).
 * The reporter picks the original from the templates the gallery has loaded;
 * an admin compares the two and the earlier on-chain listing wins.
 */
export function ReportTemplateDialog({
  template,
  candidates,
  open,
  onOpenChange,
}: {
  template: CommunityTemplate;
  /** Templates the original can be picked from (the loaded gallery). */
  candidates: CommunityTemplate[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [originalId, setOriginalId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates
      .filter((t) => t.id !== template.id)
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.creatorWallet.toLowerCase().includes(q));
  }, [candidates, template.id, query]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!originalId || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/market/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: template.id, originalId, reason: reason.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || "The report couldn't be sent.");
      toast.success("Report sent. Doqtri will compare the two templates.");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The report couldn't be sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (sending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[480px]" data-testid="report-template-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlagIcon className="text-foreground size-4" strokeWidth={1.5} />
            Report a copy
          </DialogTitle>
          <DialogDescription>
            Is “{template.title}” copied from another template? Pick the original. The template listed on-chain first
            wins; a copy is hidden from the gallery.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-3 text-[12px]">
          <label className="text-muted-foreground grid gap-1">
            Original template
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title or creator"
              disabled={sending}
            />
          </label>
          <ul
            className="grid max-h-48 gap-1 overflow-y-auto rounded-xl border border-[var(--glass-lo)] p-1"
            role="listbox"
            aria-label="Original template"
          >
            {options.length === 0 ? (
              <li className="text-muted-foreground px-2 py-3">No other templates match.</li>
            ) : (
              options.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={t.id === originalId}
                    onClick={() => setOriginalId(t.id)}
                    data-testid={`report-original-${t.id}`}
                    className={cn(
                      "flex w-full justify-between gap-2 rounded-lg px-2 py-1.5 text-left",
                      t.id === originalId ? "bg-[var(--glass-strong)] text-foreground" : "hover:bg-[var(--glass)]",
                    )}
                  >
                    <span className="truncate">{t.title}</span>
                    <span className="text-label shrink-0 font-mono">{shortAddress(t.creatorWallet)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
          <label className="text-muted-foreground grid gap-1">
            <span className="flex justify-between">
              Why do you think it&apos;s a copy? (optional)
              <span className="tabular-nums">
                {reason.length}/{MAX_REASON}
              </span>
            </span>
            <Textarea
              value={reason}
              maxLength={MAX_REASON}
              onChange={(e) => setReason(e.target.value)}
              disabled={sending}
              className="text-[13px]"
            />
          </label>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={sending} onClick={() => onOpenChange(false)}>
              <XIcon />
              Cancel
            </Button>
            <Button type="submit" disabled={!originalId || sending} data-testid="report-submit">
              {sending ? <Loader2Icon className="animate-spin" /> : <FlagIcon />}
              {sending ? "Sending…" : "Send report"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
