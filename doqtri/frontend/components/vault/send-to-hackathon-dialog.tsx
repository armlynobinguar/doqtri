"use client";

import { useEffect, useState } from "react";
import { ExternalLinkIcon, Loader2Icon, TrophyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HeadingSelect } from "@/components/vault/node-link-list";
import { qditHackathonEnabled } from "@/lib/integrations/qdit-config";
import {
  HACKATHON_SEND_COPY as COPY,
  parseHackathonInput,
  type HackathonSendResponse,
  type HackathonSendSuccess,
} from "@/lib/integrations/qdit-hackathon-send";

/**
 * "Send to qdit hackathon" on the global mindmap (WP-4.7, D-117). The
 * workspace admin picks a qdit project and pastes the hackathon's link; the
 * server builds the snapshot of every note in the active workspace and its
 * global mindmap and sends it to that project's entry
 * (POST /api/integrations/qdit/hackathon). Sending is not submitting: the
 * team then submits, or resubmits, in qdit.
 *
 * The page decides who sees the button (the flag, admin or owner here, qdit
 * connected) and hands over `setup`; the route checks all of it again.
 */

export type LinkedQditProject = { id: string; name: string };

export type HackathonSendSetup = {
  workspaceId: string;
  workspaceName: string;
  /** qdit's origin, for the link placeholder and the host check; null when unknown. */
  qditOrigin: string | null;
  /** qdit projects this workspace's notes are linked to, offered first. */
  linkedProjects: LinkedQditProject[];
};

type QditProjectOption = { id: string; name: string; can_link: boolean };

const API = "/api/integrations/qdit";

/** The header button, or nothing when the flag is off or the page gave no setup. */
export function SendToHackathonButton({ setup, noteCount }: { setup: HackathonSendSetup | null; noteCount: number }) {
  const [open, setOpen] = useState(false);
  // A new dialog each opening, so it starts from a clean form.
  const [opening, setOpening] = useState(0);
  if (!setup || !qditHackathonEnabled()) return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 text-[12px] max-lg:h-9"
        onClick={() => {
          setOpening((n) => n + 1);
          setOpen(true);
        }}
      >
        <TrophyIcon strokeWidth={1.5} />
        <span className="max-sm:sr-only">Send to qdit hackathon</span>
      </Button>
      <SendToHackathonDialog key={opening} open={open} onOpenChange={setOpen} setup={setup} noteCount={noteCount} />
    </>
  );
}

/** The project picker's entries: linked projects first, then the user's other qdit projects they administer. */
export function projectChoices(
  linked: LinkedQditProject[],
  qditProjects: QditProjectOption[] | null,
): { id: string; label: string }[] {
  const key = (id: string) => id.toLowerCase();
  const administered = qditProjects ? new Set(qditProjects.filter((p) => p.can_link).map((p) => key(p.id))) : null;
  // Until qdit's list is in (or if it fails), linked projects are offered as
  // is; qdit itself refuses a project the user does not administer.
  const first = linked.filter((p) => !administered || administered.has(key(p.id)));
  const seen = new Set(first.map((p) => key(p.id)));
  const rest = (qditProjects ?? []).filter((p) => p.can_link && !seen.has(key(p.id)));
  return [
    ...first.map((p) => ({ id: p.id, label: `${p.name} · linked here` })),
    ...rest.map((p) => ({ id: p.id, label: p.name })),
  ];
}

export function SendToHackathonDialog({
  open,
  onOpenChange,
  setup,
  noteCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setup: HackathonSendSetup;
  noteCount: number;
}) {
  const [qditProjects, setQditProjects] = useState<QditProjectOption[] | null>(null);
  const [projectsState, setProjectsState] = useState<"loading" | "loaded" | "failed">("loading");
  const [projectChoice, setProjectChoice] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HackathonSendSuccess | null>(null);

  // qdit's project list, once per opening (the dialog is remounted each time).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch(`${API}/projects`)
      .then(async (res) => {
        const payload = (await res.json().catch(() => null)) as { projects?: QditProjectOption[] } | null;
        if (!res.ok || !Array.isArray(payload?.projects)) throw new Error("projects");
        if (cancelled) return;
        setQditProjects(payload.projects);
        setProjectsState("loaded");
      })
      .catch(() => {
        if (!cancelled) setProjectsState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const choices = projectChoices(setup.linkedProjects, qditProjects);
  const selected = choices.some((c) => c.id === projectChoice) ? projectChoice : (choices[0]?.id ?? "");
  const slug = parseHackathonInput(link, setup.qditOrigin);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!selected) {
      setError(COPY.pickProject);
      return;
    }
    if (!slug) {
      setError(COPY.badLink);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/hackathon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hackathon: link.trim(), project_id: selected, workspace_id: setup.workspaceId }),
      });
      const payload = (await res.json().catch(() => null)) as HackathonSendResponse | null;
      if (payload?.ok === true) setResult(payload);
      else setError(payload?.message ?? COPY.unavailable);
    } catch {
      setError(COPY.unavailable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        {result ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TrophyIcon className="text-foreground size-4" strokeWidth={1.5} />
                Sent to qdit
              </DialogTitle>
            </DialogHeader>
            <SendResult result={result} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={send} className="grid gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TrophyIcon className="text-foreground size-4" strokeWidth={1.5} />
                Send to qdit hackathon
              </DialogTitle>
              <DialogDescription className="text-muted-foreground leading-relaxed">
                Sends a copy of all {noteCount} {noteCount === 1 ? "note" : "notes"} in {setup.workspaceName} and the
                global mindmap to a qdit project&apos;s hackathon entry.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-1.5">
              <span className="text-label text-[12px]">qdit project</span>
              {choices.length > 0 ? (
                <HeadingSelect label="qdit project" nodes={choices} value={selected} onChange={setProjectChoice} />
              ) : projectsState === "loading" ? (
                <p className="text-muted-foreground flex items-center gap-2 text-[12px]">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  Loading your qdit projects…
                </p>
              ) : (
                <p className="text-muted-foreground text-[12px]">
                  {projectsState === "failed"
                    ? "Your qdit projects couldn't be loaded. Close this and try again."
                    : "You aren't an admin of any qdit project. A project's owner can make you one in qdit."}
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="hackathon-link" className="text-label text-[12px]">
                Hackathon link
              </label>
              <Input
                id="hackathon-link"
                autoFocus
                value={link}
                disabled={busy}
                placeholder={`${setup.qditOrigin ?? "https://qdit.app"}/hackathons/…`}
                aria-invalid={error ? true : undefined}
                onChange={(event) => {
                  setLink(event.target.value);
                  setError(null);
                }}
              />
            </div>

            <p className="text-muted-foreground text-[12px] leading-relaxed">{COPY.visibility}</p>

            {error ? (
              <p role="alert" className="text-destructive text-[12px]">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !selected || !link.trim()}>
                {busy ? (
                  <>
                    <Loader2Icon className="animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Send"
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What a send did, and what the team does next in qdit. */
export function SendResult({ result }: { result: HackathonSendSuccess }) {
  const next = COPY.next[result.submission_state];
  return (
    <div className="grid gap-3 text-[13px] leading-relaxed">
      <p className="text-foreground">
        qdit received {result.note_count} {result.note_count === 1 ? "note" : "notes"} and the global mindmap.
      </p>
      <p className="text-foreground font-medium">
        {result.qdit_url ? (
          <a
            href={result.qdit_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-3"
          >
            {next}
            <ExternalLinkIcon className="size-3.5" />
          </a>
        ) : (
          next
        )}
      </p>
      {result.warnings.length > 0 ? (
        <ul className="text-muted-foreground grid list-disc gap-1 pl-4 text-[12px]">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
