"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLinkIcon, Loader2Icon, MilestoneIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status-tag";
import {
  HeadingSelect,
  LINK_INPUT_CLASS,
  LinkItemShell,
  LinkList,
  LinkSection,
} from "@/components/vault/node-link-list";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  DOC_PROJECT_LINK_COLUMNS,
  linkableNodes,
  QDIT_LINK_COLUMNS,
  QDIT_STATE_TEXT,
  type DocProjectLinkRow,
  type LinkableNode,
  type QditLinkRow,
} from "@/lib/node-links";

/**
 * The qdit provider of the ship panel's link list (WP-2.5). Shown only with
 * NEXT_PUBLIC_QDIT_INTEGRATION=1 (node-links.tsx decides).
 *
 * The note links to one qdit project (D-09), which only an admin or owner of
 * the workspace links or unlinks (D-10); then editors create a milestone from
 * a heading, take over one qdit already links to this note, relink or unlink
 * one. Everything goes through /api/integrations/qdit, as the user, so qdit's
 * own project role applies too (D-23); viewers see the links and nothing to
 * change. Without a qdit connection the panel asks the user to connect.
 *
 * Rows are read straight from the database (viewers may read them, RLS) and
 * re-read a few seconds after the note changes, since each save may move or
 * rename links (R-03).
 */

const CONNECT_URL = "/api/integrations/qdit/connect";
const API = "/api/integrations/qdit";

type Connection = "loading" | "connected" | "needs_reconnect" | "none";
type ProjectOption = { id: string; name: string; can_link: boolean };

const TONE: Record<QditLinkRow["qdit_state"], "verified" | "info" | "warning" | "danger"> = {
  linked: "verified",
  pending: "info",
  ambiguous: "warning",
  broken: "danger",
  conflict: "warning",
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw Object.assign(new Error(payload.error ?? "qdit request failed"), { code: payload.code });
  return payload;
}

export function QditLinks({
  docId,
  nodes,
  nodesKey,
  taken,
  onLinkedChange,
  onSave,
}: {
  docId: string;
  nodes: LinkableNode[];
  /** Changes when the note's headings change: links are re-read after the save. */
  nodesKey: string;
  /** Headings linked by another provider (D-08). */
  taken: string[];
  onLinkedChange: (nodeIds: string[]) => void;
  /** Saves the note, so a milestone is made from the heading as stored. */
  onSave: () => Promise<string>;
}) {
  const [connection, setConnection] = useState<Connection>("loading");
  const [project, setProject] = useState<DocProjectLinkRow | null>(null);
  const [links, setLinks] = useState<QditLinkRow[]>([]);
  const [role, setRole] = useState<{ editor: boolean; admin: boolean }>({ editor: false, admin: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [projectChoice, setProjectChoice] = useState("");
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  // qdit answered QDIT_UNCONFIRMED: the project is out of the admin's sight,
  // so the only way left is to forget the link on doqtri's side.
  const [forgettable, setForgettable] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [nodeChoice, setNodeChoice] = useState("");
  const [existingId, setExistingId] = useState("");
  const [showExisting, setShowExisting] = useState(false);
  const [relinkChoice, setRelinkChoice] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    const [projectRes, linksRes] = await Promise.all([
      supabase.from("doc_project_links").select(DOC_PROJECT_LINK_COLUMNS).eq("document_id", docId).maybeSingle(),
      supabase
        .from("node_links")
        .select(QDIT_LINK_COLUMNS)
        .eq("document_id", docId)
        .eq("provider", "qdit")
        .order("created_at"),
    ]);
    if (projectRes.error || linksRes.error) {
      toast.error("Could not load qdit links");
      return;
    }
    setProject((projectRes.data as DocProjectLinkRow | null) ?? null);
    const rows = (linksRes.data ?? []) as QditLinkRow[];
    setLinks(rows);
    onLinkedChange(rows.map((r) => r.node_id));
  }, [docId, onLinkedChange]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const [{ data: conns }, { data: doc }] = await Promise.all([
        supabase.rpc("my_integration_connections"),
        supabase.from("documents").select("workspace_id").eq("id", docId).maybeSingle(),
      ]);
      const qdit = ((conns ?? []) as { provider: string; status: string }[]).find((c) => c.provider === "qdit");
      if (!cancelled) {
        setConnection(
          qdit?.status === "connected" ? "connected" : qdit?.status === "needs_reconnect" ? "needs_reconnect" : "none",
        );
      }
      if (doc?.workspace_id) {
        const [editor, admin] = await Promise.all(
          (["editor", "admin"] as const).map((min) =>
            supabase.rpc("is_workspace_member", { p_workspace_id: doc.workspace_id, p_min_role: min }),
          ),
        );
        if (!cancelled) setRole({ editor: editor.data === true, admin: admin.data === true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // Now, and a moment after the headings change (the save remaps links).
  const loaded = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => void load(), loaded.current ? 3000 : 0);
    loaded.current = true;
    return () => clearTimeout(timer);
  }, [load, nodesKey]);

  async function run(what: string, fn: () => Promise<void>) {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "qdit request failed");
    } finally {
      setBusy(null);
      await load();
    }
  }

  const connected = connection === "connected";
  const canEdit = role.editor && connected;
  const unlinked = linkableNodes(nodes, "qdit", [...links.map((l) => l.node_id), ...taken]);
  const selectedNode = unlinked.some((n) => n.id === nodeChoice) ? nodeChoice : unlinked[0]?.id ?? "";
  const headingNodes = nodes.filter((n) => n.id !== "root");
  const pending = links.filter((l) => l.qdit_state === "pending");
  const labelOf = (nodeId: string) => nodes.find((n) => n.id === nodeId)?.label;

  async function chooseProject() {
    await run("projects", async () => {
      const { projects: list } = await call<{ projects: ProjectOption[] }>("GET", "/projects");
      setProjects(list);
      setProjectChoice(list.find((p) => p.can_link)?.id ?? "");
    });
  }

  const linkProject = () =>
    run("project", async () => {
      await call("POST", `/docs/${docId}/project`, { projectId: projectChoice });
      setProjects(null);
      toast.success("Note linked to qdit");
    });

  const unlinkProject = () =>
    run("project", async () => {
      setConfirmUnlink(false);
      try {
        await call("DELETE", `/docs/${docId}/project`);
      } catch (e) {
        if ((e as { code?: string }).code === "QDIT_UNCONFIRMED") setForgettable(true);
        throw e;
      }
      toast.success("Note unlinked from qdit. Its milestones stay in qdit.");
    });

  const forgetProject = () =>
    run("project", async () => {
      setConfirmForget(false);
      await call("DELETE", `/docs/${docId}/project?forget=1`);
      setForgettable(false);
      toast.success("Link forgotten in Doqtri. qdit may still list this note and its milestone links.");
    });

  const createMilestone = (milestoneId?: string) =>
    run("create", async () => {
      // Milestones are made from the saved heading; a failed save is
      // reported by the route if the heading is not stored yet.
      // The heading's text goes along: if the save was refused, the stored
      // note may have another heading at this id, and the route says so.
      await onSave().catch(() => undefined);
      await call("POST", `/docs/${docId}/milestones`, {
        nodeId: selectedNode,
        nodeLabel: labelOf(selectedNode),
        ...(milestoneId ? { milestoneId } : {}),
      });
      setExistingId("");
      setShowExisting(false);
      toast.success(milestoneId ? "Milestone linked" : "Milestone created in qdit");
    });

  const unlinkMilestone = (link: QditLinkRow) =>
    run(`unlink:${link.id}`, async () => {
      await call("DELETE", `/links/${link.id}`);
      toast.success("Unlinked. The milestone stays in qdit.");
    });

  const relink = (link: QditLinkRow, nodeId: string) =>
    run(`relink:${link.id}`, async () => {
      await onSave().catch(() => undefined);
      const { failed } = await call<{ failed: { message: string }[] }>("PATCH", `/links/${link.id}`, {
        nodeId,
        nodeLabel: labelOf(nodeId),
      });
      if (failed.length > 0) toast.warning(`Relinked here; qdit will follow: ${failed[0].message}`);
      else toast.success("Relinked");
    });

  const retry = () =>
    run("sync", async () => {
      const result = await call<{ skipped: boolean; failed: { message: string }[] }>("POST", `/docs/${docId}/sync`);
      if (result.skipped) toast.info("qdit is already being updated.");
      else if (result.failed.length > 0) toast.error(result.failed[0].message);
      else toast.success("qdit is up to date");
    });

  return (
    <LinkSection
      testId="qdit-links"
      icon={<MilestoneIcon className="size-3.5" />}
      title="qdit"
      action={
        canEdit && pending.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px] max-lg:h-9 max-lg:px-2.5"
            disabled={busy != null}
            onClick={() => void retry()}
          >
            {busy === "sync" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Retry
          </Button>
        ) : null
      }
    >
      {connection !== "loading" && !connected ? (
        <div className="grid gap-1.5">
          <p className="text-muted-foreground text-[11px] leading-snug">
            {connection === "needs_reconnect"
              ? "Your qdit connection has expired or was revoked. Reconnect to link headings to milestones."
              : "Connect your qdit account to link this note to a project and its headings to milestones."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full max-lg:h-10"
            render={<a href={CONNECT_URL} />}
          >
            <PlugIcon />
            {connection === "needs_reconnect" ? "Reconnect qdit" : "Connect qdit"}
          </Button>
        </div>
      ) : null}

      {project ? (
        <div className="flex flex-wrap items-center justify-between gap-1.5 text-[12px]">
          <span className="text-muted-foreground min-w-0 truncate">
            Project{" "}
            {project.project_url ? (
              <a
                href={project.project_url}
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
              >
                {project.project_name}
              </a>
            ) : (
              <span className="text-foreground">{project.project_name}</span>
            )}
          </span>
          {role.admin && connected ? (
            <Button
              type="button"
              size="sm"
              variant={confirmUnlink ? "destructive" : "ghost"}
              className="h-6 px-1.5 text-[11px] max-lg:h-9 max-lg:px-2.5"
              disabled={busy != null}
              onClick={() => (confirmUnlink ? void unlinkProject() : setConfirmUnlink(true))}
            >
              {busy === "project" ? <Loader2Icon className="animate-spin" /> : null}
              {confirmUnlink ? "Unlink, and every milestone link" : "Unlink project"}
            </Button>
          ) : null}
          {role.admin && connected && forgettable ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-1.5">
              <span className="text-muted-foreground min-w-0 flex-1 text-[11px]">
                qdit no longer shows you this project. Forgetting removes the link from Doqtri only; qdit may
                still list this note and its milestone links.
              </span>
              <Button
                type="button"
                size="sm"
                variant={confirmForget ? "destructive" : "ghost"}
                className="h-6 px-1.5 text-[11px] max-lg:h-9 max-lg:px-2.5"
                disabled={busy != null}
                onClick={() => (confirmForget ? void forgetProject() : setConfirmForget(true))}
              >
                {confirmForget ? "Forget it in Doqtri" : "Forget link here"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : connection === "loading" ? null : role.admin && connected ? (
        projects === null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full max-lg:h-10"
            disabled={busy != null}
            onClick={() => void chooseProject()}
          >
            {busy === "projects" ? <Loader2Icon className="animate-spin" /> : null}
            Link to a qdit project
          </Button>
        ) : projects.some((p) => p.can_link) ? (
          <div className="flex gap-1.5">
            <div className="min-w-0 flex-1">
              <HeadingSelect
                label="qdit project"
                nodes={projects.filter((p) => p.can_link).map((p) => ({ id: p.id, label: p.name }))}
                value={projectChoice}
                onChange={setProjectChoice}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 max-lg:h-10"
              disabled={busy != null || !projectChoice}
              onClick={() => void linkProject()}
            >
              {busy === "project" ? <Loader2Icon className="animate-spin" /> : null}
              Link
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-[11px] leading-snug">
            You aren&apos;t an admin or owner of any qdit project, so there is none to link this note to.
          </p>
        )
      ) : (
        <p className="text-muted-foreground text-[11px] leading-snug">
          An admin of this workspace links the note to a qdit project. Then its headings can become milestones.
        </p>
      )}

      {project || links.length > 0 ? (
        <LinkList
          count={links.length}
          empty="Make a milestone from a heading. The heading's text stays its title: rename the heading here and qdit follows."
        >
          {links.map((link) => {
            const text = QDIT_STATE_TEXT[link.qdit_state];
            const problem = link.qdit_state === "ambiguous" || link.qdit_state === "broken" || link.qdit_state === "conflict";
            const choices = linkableNodes(headingNodes, "qdit", [
              ...links.filter((l) => l.id !== link.id).map((l) => l.node_id),
              ...taken,
            ]);
            const choice = choices.some((n) => n.id === relinkChoice[link.id])
              ? relinkChoice[link.id]
              : choices[0]?.id ?? "";
            return (
              <LinkItemShell
                key={link.id}
                label={link.node_label || link.node_id}
                removeLabel={`Unlink the milestone from “${link.node_label}”`}
                onRemove={canEdit && busy == null ? () => void unlinkMilestone(link) : undefined}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusTag tone={TONE[link.qdit_state]}>{text.tag}</StatusTag>
                  {link.qdit_url ? (
                    <a
                      href={link.qdit_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground inline-flex items-center gap-1 text-[11px] hover:underline"
                    >
                      Open in qdit
                      <ExternalLinkIcon className="size-3" />
                    </a>
                  ) : null}
                </div>
                {text.note ? (
                  <p className={problem ? "text-warning text-[11px] leading-snug" : "text-muted-foreground text-[11px] leading-snug"}>
                    {text.note}
                  </p>
                ) : null}
                {problem && canEdit && choices.length > 0 ? (
                  <div className="flex gap-1.5">
                    <div className="min-w-0 flex-1">
                      <HeadingSelect
                        label="Heading to relink to"
                        nodes={choices}
                        value={choice}
                        onChange={(id) => setRelinkChoice((c) => ({ ...c, [link.id]: id }))}
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 max-lg:h-10"
                      disabled={busy != null || !choice}
                      onClick={() => void relink(link, choice)}
                    >
                      {busy === `relink:${link.id}` ? <Loader2Icon className="animate-spin" /> : null}
                      Relink
                    </Button>
                  </div>
                ) : null}
              </LinkItemShell>
            );
          })}
        </LinkList>
      ) : null}

      {project && canEdit && unlinked.length > 0 ? (
        <div className="grid gap-1.5">
          <HeadingSelect nodes={unlinked} value={selectedNode} onChange={setNodeChoice} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full max-lg:h-10"
            disabled={busy != null || !selectedNode}
            onClick={() => void createMilestone()}
          >
            {busy === "create" ? <Loader2Icon className="animate-spin" /> : null}
            Create milestone
          </Button>
          {showExisting ? (
            <div className="flex gap-1.5">
              <input
                aria-label="qdit milestone id"
                className={LINK_INPUT_CLASS}
                placeholder="Milestone id"
                value={existingId}
                onChange={(e) => setExistingId(e.target.value)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 max-lg:h-10"
                disabled={busy != null || !existingId.trim()}
                onClick={() => void createMilestone(existingId.trim())}
              >
                Link
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className="text-muted-foreground justify-self-start text-[11px] hover:underline"
              onClick={() => setShowExisting(true)}
            >
              Link an existing milestone instead
            </button>
          )}
        </div>
      ) : null}
    </LinkSection>
  );
}
