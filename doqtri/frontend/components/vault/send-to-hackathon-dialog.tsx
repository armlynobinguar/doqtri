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
 * workspace admin picks a qdit project and one of the open hackathons qdit
 * lists (D-122; upcoming ones are shown but cannot be picked); the server
 * builds the snapshot of every note in the active workspace and its global
 * mindmap and sends it to that project's entry
 * (POST /api/integrations/qdit/hackathon). Sending is not submitting: the
 * team then submits, or resubmits, in qdit. While qdit has no hackathon list
 * (before QDIT-60), the admin pastes the hackathon's link instead.
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

/** A hackathon as GET /api/integrations/qdit/hackathons lists it (D-122). */
export type QditHackathonOption = { slug: string; name: string; opens_at: string; closes_at: string; state: string };

/** A fixed locale for tests; the dialog uses the viewer's own. */
type DateOptions = { locale?: string };

/** Event dates read in the event's own timezone, as qdit's banner and hackathon page do (BANNER_TIMEZONE). */
export const HACKATHON_TIMEZONE = "Asia/Manila";

/**
 * Where the hackathon list stands. `unavailable`: qdit has no list yet
 * (before QDIT-60), so the dialog asks for the hackathon's link instead.
 */
export type HackathonsState = "loading" | "loaded" | "failed" | "unavailable";

/** The send form as the dialog holds it. `pickedSlug` comes from pickedHackathon(). */
export type HackathonSendForm = {
  projectId: string;
  hackathonsState: HackathonsState;
  pickedSlug: string;
  link: string;
};

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

/**
 * A short day and month ("14 Nov", "Nov 14") in the event's timezone
 * (Asia/Manila), or null when `iso` is not a time.
 */
export function opensOn(iso: string, { locale }: DateOptions = {}): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: HACKATHON_TIMEZONE }).format(at);
  } catch {
    return null;
  }
}

/**
 * The hackathon picker's entries, in qdit's order: open hackathons can be
 * picked; upcoming ones show when they open and are disabled, since qdit
 * refuses a snapshot before then. A state doqtri doesn't know is left out.
 */
export function hackathonChoices(
  hackathons: QditHackathonOption[],
  dates: DateOptions = {},
): { id: string; label: string; disabled: boolean }[] {
  return hackathons.flatMap((h): { id: string; label: string; disabled: boolean }[] => {
    if (h.state === "open") return [{ id: h.slug, label: h.name, disabled: false }];
    if (h.state !== "upcoming") return [];
    const date = opensOn(h.opens_at, dates);
    return [{ id: h.slug, label: date ? `${h.name} · opens ${date}` : `${h.name} · not open yet`, disabled: true }];
  });
}

/** The hackathon to send to: `current` while it can be picked, else the first open one, else none (""). */
export function pickedHackathon(choices: { id: string; disabled: boolean }[], current: string): string {
  const pickable = choices.filter((c) => !c.disabled);
  return pickable.some((c) => c.id === current) ? current : (pickable[0]?.id ?? "");
}

/**
 * Whether Send is enabled: a project, and an open hackathon picked from the
 * list, or, while qdit has no list, something in the link field (the route
 * checks the link). Never while the list is loading or failed.
 */
export function canSend(form: HackathonSendForm): boolean {
  if (!form.projectId) return false;
  if (form.hackathonsState === "unavailable") return !!form.link.trim();
  return form.hackathonsState === "loaded" && !!form.pickedSlug;
}

/**
 * The POST /api/integrations/qdit/hackathon body: the picked hackathon's bare
 * slug, or the pasted link as typed (trimmed) while qdit has no list. The
 * route reads either with parseHackathonInput().
 */
export function sendBody(
  form: HackathonSendForm,
  workspaceId: string,
): { hackathon: string; project_id: string; workspace_id: string } {
  return {
    hackathon: form.hackathonsState === "unavailable" ? form.link.trim() : form.pickedSlug,
    project_id: form.projectId,
    workspace_id: workspaceId,
  };
}

/** Send refusals after which the hackathon list may be stale: reload it. */
const STALE_HACKATHON_CODES: ReadonlySet<string> = new Set(["HACKATHON_CLOSED", "HACKATHON_NOT_OPEN", "QDIT_NOT_FOUND"]);

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
  const [hackathons, setHackathons] = useState<QditHackathonOption[]>([]);
  const [hackathonsState, setHackathonsState] = useState<HackathonsState>("loading");
  // Bumped after a refusal that says the list is stale, to load it again.
  const [hackathonsReload, setHackathonsReload] = useState(0);
  const [hackathonChoice, setHackathonChoice] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After no answer from qdit: where to check whether the snapshot landed.
  const [checkUrl, setCheckUrl] = useState<string | null>(null);
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

  // qdit's hackathon list, once per opening and again after a refusal that
  // says it is stale. A reload that fails keeps the list already shown.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch(`${API}/hackathons`)
      .then(async (res) => {
        const payload = (await res.json().catch(() => null)) as {
          hackathons?: QditHackathonOption[] | null;
          list_unavailable?: boolean;
        } | null;
        if (!res.ok || !payload) throw new Error("hackathons");
        if (cancelled) return;
        // qdit without GET /hackathons: ask for the link as before. Remove
        // this fallback (and the link field) once QDIT-60 is in production.
        if (payload.list_unavailable === true) {
          setHackathonsState("unavailable");
          return;
        }
        if (!Array.isArray(payload.hackathons)) throw new Error("hackathons");
        setHackathons(payload.hackathons);
        setHackathonsState("loaded");
      })
      .catch(() => {
        if (!cancelled) setHackathonsState((state) => (state === "loaded" ? state : "failed"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, hackathonsReload]);

  const choices = projectChoices(setup.linkedProjects, qditProjects);
  const selected = choices.some((c) => c.id === projectChoice) ? projectChoice : (choices[0]?.id ?? "");
  const pastingLink = hackathonsState === "unavailable";
  const hackathonOptions = hackathonChoices(hackathons);
  const pickedSlug = pickedHackathon(hackathonOptions, hackathonChoice);
  const form: HackathonSendForm = { projectId: selected, hackathonsState, pickedSlug, link };
  const slug = pastingLink ? parseHackathonInput(link, setup.qditOrigin) : pickedSlug || null;

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!selected) {
      setError(COPY.pickProject);
      return;
    }
    if (!slug) {
      setError(pastingLink ? COPY.badLink : COPY.pickHackathon);
      return;
    }
    setBusy(true);
    setError(null);
    setCheckUrl(null);
    try {
      const res = await fetch(`${API}/hackathon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sendBody(form, setup.workspaceId)),
      });
      const payload = (await res.json().catch(() => null)) as HackathonSendResponse | null;
      if (payload?.ok === true) setResult(payload);
      else {
        setError(payload?.message ?? COPY.unavailable);
        if (payload?.code === "QDIT_UNCERTAIN") setCheckUrl(payload.qdit_url ?? null);
        // The hackathon closed, has not opened or is gone: show qdit's list as
        // it is now. The message stays until the user changes something.
        if (!pastingLink && payload && STALE_HACKATHON_CODES.has(payload.code)) setHackathonsReload((n) => n + 1);
      }
    } catch {
      // The request may have reached doqtri, and doqtri qdit.
      setError(COPY.uncertain);
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

            {pastingLink ? (
              <div className="grid gap-1.5">
                <label htmlFor="hackathon-link" className="text-label text-[12px]">
                  Hackathon link
                </label>
                <Input
                  id="hackathon-link"
                  value={link}
                  disabled={busy}
                  placeholder={setup.qditOrigin ? `${setup.qditOrigin}/hackathons/…` : "hackathon-name"}
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => {
                    setLink(event.target.value);
                    setError(null);
                    setCheckUrl(null);
                  }}
                />
              </div>
            ) : (
              <div className="grid gap-1.5">
                <span className="text-label text-[12px]">Hackathon</span>
                {hackathonOptions.length > 0 ? (
                  <>
                    {/* Only upcoming ones: nothing picked, and the trigger says so. */}
                    <HeadingSelect
                      label="Hackathon"
                      nodes={hackathonOptions}
                      value={pickedSlug}
                      placeholder={COPY.pickHackathon}
                      onChange={(next) => {
                        setHackathonChoice(next);
                        setError(null);
                        setCheckUrl(null);
                      }}
                    />
                    {pickedSlug ? null : <p className="text-muted-foreground text-[12px]">{COPY.noOpenHackathons}</p>}
                  </>
                ) : hackathonsState === "loading" ? (
                  <p className="text-muted-foreground flex items-center gap-2 text-[12px]">
                    <Loader2Icon className="size-3.5 animate-spin" />
                    {COPY.hackathonsLoading}
                  </p>
                ) : (
                  <p className="text-muted-foreground text-[12px]">
                    {hackathonsState === "failed" ? COPY.hackathonsFailed : COPY.noOpenHackathons}
                  </p>
                )}
              </div>
            )}

            <p className="text-muted-foreground text-[12px] leading-relaxed">{COPY.visibility}</p>

            {error ? <SendError message={error} checkUrl={checkUrl} /> : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !canSend(form)}>
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

/** A refusal, and after no answer from qdit, the link to check the entry there. */
export function SendError({ message, checkUrl }: { message: string; checkUrl: string | null }) {
  return (
    <p role="alert" className="text-destructive text-[12px]">
      {message}
      {checkUrl ? (
        <>
          {" "}
          <a
            href={checkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-3"
          >
            Check your entry in qdit
            <ExternalLinkIcon className="size-3" />
          </a>
        </>
      ) : null}
    </p>
  );
}
