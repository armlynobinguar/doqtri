import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QditError, type QditClient, type QditMilestone, type QditRole } from "@/lib/integrations/qdit-client";
import { headingsOf, planRemap, remapChanges, type Heading, type RemapLink } from "@/lib/node-remap";
import {
  DOC_PROJECT_LINK_COLUMNS,
  isHeadingId,
  QDIT_LINK_COLUMNS,
  type DocProjectLinkRow,
  type QditLinkRow,
} from "@/lib/node-links";

/**
 * Linking a note and its headings to qdit (WP-2.5; server-only).
 *
 * docs/integration/CONTRACT.md is the reference; section numbers point into
 * it. Each function here talks to qdit as one user (their QditClient, so
 * qdit's own project roles decide, D-23) and writes doqtri's copy with the
 * service role, because signed-in users only read doc_project_links and qdit
 * node_links (20261025110000_qdit_linking.sql). The routes check the
 * caller's workspace role before calling in: admin or owner for the
 * project (D-10), editor or above for headings.
 *
 * qdit is written first and doqtri's copy after, from what qdit answered,
 * so doqtri never shows a link qdit does not hold. The one exception is a
 * heading moving or being renamed: the save has already happened, so
 * doqtri's row changes at once (`pending`) and syncQditLinks() tells qdit
 * after.
 *
 * Every failure is a LinkingError with a status for the route and a message
 * safe to show.
 */

export class LinkingError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string = "LINKING",
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "LinkingError";
  }
}

/** The LinkingError for a qdit failure the caller does not handle itself. */
export function fromQditError(error: unknown): LinkingError {
  if (error instanceof LinkingError) return error;
  if (!(error instanceof QditError)) {
    return new LinkingError(500, error instanceof Error ? error.message : "Something went wrong.");
  }
  switch (error.kind) {
    case "not_connected":
      return new LinkingError(409, error.message, "QDIT_NOT_CONNECTED");
    case "not_configured":
      return new LinkingError(503, "qdit isn't set up on this deployment.", "QDIT_NOT_CONFIGURED");
    case "forbidden":
      return new LinkingError(403, "Your role in that qdit project doesn't allow this.", "QDIT_FORBIDDEN");
    case "not_found":
      return new LinkingError(
        404,
        "qdit can't find that, or you no longer have access to it.",
        "QDIT_NOT_FOUND",
      );
    case "rate_limited":
      return new LinkingError(
        429,
        "qdit is busy. Try again in a moment.",
        "QDIT_RATE_LIMITED",
        error.retryAfterSeconds,
      );
    case "invalid_request":
    case "conflict":
      // qdit's message is English and safe to show (section 6).
      return new LinkingError(error.kind === "conflict" ? 409 : 400, error.message, "QDIT_REFUSED");
    default:
      return new LinkingError(502, "qdit couldn't be reached. Try again.", "QDIT_UNAVAILABLE");
  }
}

const QDIT_RANK: Record<QditRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
const qditRoleAtLeast = (role: QditRole, min: QditRole) => (QDIT_RANK[role] ?? 0) >= QDIT_RANK[min];

const isQdit = (error: unknown, kind: QditError["kind"], reason?: string) =>
  error instanceof QditError && error.kind === kind && (reason === undefined || error.reason === reason);

/** The note's on-chain version, or null if not anchored or unreadable. */
export type ChainVersion = (docId: string) => Promise<number | null>;

/** The URL qdit links back to: doqtri's own origin and the note's page (D-45, section 8). */
export function docUrl(siteUrl: string, docId: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/d/${docId}`;
}

/** qdit takes a title of 1 to 300 characters after trimming (section 8). */
const MAX_TITLE = 300;

export async function loadProjectLink(admin: SupabaseClient, docId: string): Promise<DocProjectLinkRow | null> {
  const { data, error } = await admin
    .from("doc_project_links")
    .select(DOC_PROJECT_LINK_COLUMNS)
    .eq("document_id", docId)
    .maybeSingle();
  if (error) throw new LinkingError(500, `Could not read the note's qdit project: ${error.message}`);
  return (data as DocProjectLinkRow | null) ?? null;
}

async function loadQditLinks(admin: SupabaseClient, docId: string): Promise<QditLinkRow[]> {
  const { data, error } = await admin
    .from("node_links")
    .select(QDIT_LINK_COLUMNS)
    .eq("document_id", docId)
    .eq("provider", "qdit")
    .order("created_at");
  if (error) throw new LinkingError(500, `Could not read the note's qdit links: ${error.message}`);
  return (data ?? []) as QditLinkRow[];
}

// ---------------------------------------------------------------------------
// The note's project (D-09, D-10)
// ---------------------------------------------------------------------------

/**
 * Links the note to a qdit project (POST /projects/{id}/docs). Re-linking to
 * the same project refreshes the title and URL qdit holds. A note already
 * linked to another project must be unlinked first, here as in qdit.
 */
export async function linkProject(params: {
  admin: SupabaseClient;
  client: QditClient;
  userId: string;
  doc: { id: string; title: string };
  projectId: string;
  siteUrl: string;
}): Promise<DocProjectLinkRow> {
  const { admin, client, userId, doc, projectId, siteUrl } = params;
  const existing = await loadProjectLink(admin, doc.id);
  if (existing && existing.project_id !== projectId) {
    throw new LinkingError(
      409,
      `This note is linked to ${existing.project_name}. Unlink it there first.`,
      "ALREADY_LINKED",
    );
  }

  let project;
  try {
    project = (await client.listAllProjects()).find((p) => p.id === projectId);
  } catch (error) {
    throw fromQditError(error);
  }
  if (!project) {
    throw new LinkingError(404, "That qdit project wasn't found, or you aren't a member of it.", "QDIT_NOT_FOUND");
  }
  if (!qditRoleAtLeast(project.role, "admin")) {
    throw new LinkingError(
      403,
      `Only an admin or owner of ${project.name} in qdit can link notes to it.`,
      "QDIT_FORBIDDEN",
    );
  }

  const title = doc.title.trim().slice(0, MAX_TITLE) || "Untitled";
  let link;
  try {
    link = await client.linkDoc(projectId, { doc_id: doc.id, doc_title: title, doc_url: docUrl(siteUrl, doc.id) });
  } catch (error) {
    if (isQdit(error, "conflict", "doc_linked_elsewhere")) {
      throw new LinkingError(
        409,
        "In qdit, this note is already linked to another project. Unlink it there first.",
        "QDIT_LINKED_ELSEWHERE",
      );
    }
    throw fromQditError(error);
  }

  const row = {
    document_id: doc.id,
    project_id: projectId,
    project_name: project.name.slice(0, MAX_TITLE),
    project_slug: project.slug.slice(0, MAX_TITLE),
    project_url: /^https?:\/\//.test(project.url) ? project.url : null,
    qdit_link_id: link.id,
    doc_url: link.doc_url,
    linked_by: userId,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await admin
    .from("doc_project_links")
    .upsert(row, { onConflict: "document_id" })
    .select(DOC_PROJECT_LINK_COLUMNS)
    .single();
  if (error || !data) {
    throw new LinkingError(500, `qdit linked the note, but doqtri could not record it: ${error?.message ?? "no row"}`);
  }
  return data as DocProjectLinkRow;
}

/**
 * Unlinks the note from its project (DELETE /projects/{id}/docs/{doc_id}).
 * qdit drops every milestone link of the note in the same transaction (D-22);
 * removing doqtri's project row drops the note's qdit node_links with it
 * (on delete cascade), which covers every id in `removed_link_ids`.
 *
 * A 404 is taken as already done only while the project is still in the
 * user's project list; otherwise qdit may still hold the link and its
 * title-locked milestones, so nothing local is removed (section 8).
 */
export async function unlinkProject(params: {
  admin: SupabaseClient;
  client: QditClient;
  docId: string;
}): Promise<{ removedLinkIds: string[] }> {
  const { admin, client, docId } = params;
  const existing = await loadProjectLink(admin, docId);
  if (!existing) throw new LinkingError(404, "This note isn't linked to a qdit project.", "NOT_LINKED");

  let removedLinkIds: string[] = [];
  try {
    removedLinkIds = (await client.unlinkDoc(existing.project_id, docId)).removed_link_ids ?? [];
  } catch (error) {
    if (!isQdit(error, "not_found")) throw fromQditError(error);
    let stillVisible: boolean;
    try {
      stillVisible = (await client.listAllProjects()).some((p) => p.id === existing.project_id);
    } catch (listError) {
      throw fromQditError(listError);
    }
    if (!stillVisible) {
      throw new LinkingError(
        409,
        `qdit didn't confirm the unlink: you may no longer have access to ${existing.project_name}. Nothing was removed here.`,
        "QDIT_UNCONFIRMED",
      );
    }
  }

  const { error } = await admin.from("doc_project_links").delete().eq("document_id", docId);
  if (error) throw new LinkingError(500, `qdit unlinked the note, but doqtri could not record it: ${error.message}`);
  return { removedLinkIds };
}

// ---------------------------------------------------------------------------
// Headings and milestones (D-06, D-08, D-11, D-12)
// ---------------------------------------------------------------------------

type LinkableDoc = { id: string; title: string; markdown: string };

/** The saved heading at `nodeId`, or a LinkingError. */
function savedHeading(doc: LinkableDoc, nodeId: string): Heading {
  if (!isHeadingId(nodeId)) {
    throw new LinkingError(400, "Only a heading can be linked to a milestone.", "NOT_A_HEADING");
  }
  const heading = headingsOf(doc.title, doc.markdown).find((h) => h.id === nodeId);
  if (!heading) {
    throw new LinkingError(409, "That heading isn't in the saved note. Save and try again.", "STALE_HEADING");
  }
  if (heading.label.length > MAX_TITLE) {
    throw new LinkingError(400, `qdit takes milestone titles of up to ${MAX_TITLE} characters.`, "TITLE_TOO_LONG");
  }
  return heading;
}

async function requireProject(admin: SupabaseClient, docId: string): Promise<DocProjectLinkRow> {
  const project = await loadProjectLink(admin, docId);
  if (!project) {
    throw new LinkingError(409, "Link this note to a qdit project first.", "NOT_LINKED");
  }
  return project;
}

async function requireFreeHeading(admin: SupabaseClient, docId: string, nodeId: string, except?: string) {
  let query = admin.from("node_links").select("id").eq("document_id", docId).eq("node_id", nodeId);
  if (except) query = query.neq("id", except);
  const { data, error } = await query.limit(1);
  if (error) throw new LinkingError(500, `Could not read the note's links: ${error.message}`);
  if ((data ?? []).length > 0) {
    throw new LinkingError(409, "That heading already has a link.", "HEADING_TAKEN");
  }
}

async function chainVersionOf(chainVersion: ChainVersion, docId: string): Promise<number | null> {
  try {
    const version = await chainVersion(docId);
    return typeof version === "number" && Number.isSafeInteger(version) && version >= 1 ? version : null;
  } catch {
    return null;
  }
}

async function insertQditRow(
  admin: SupabaseClient,
  params: { userId: string; docId: string; heading: Heading; milestone: QditMilestone; projectId: string },
): Promise<QditLinkRow> {
  const { userId, docId, heading, milestone, projectId } = params;
  const link = milestone.link!;
  const { data, error } = await admin
    .from("node_links")
    .insert({
      user_id: userId,
      document_id: docId,
      node_id: heading.id,
      node_label: heading.label,
      provider: "qdit",
      qdit_project_id: projectId,
      qdit_milestone_id: milestone.id,
      qdit_link_id: link.id,
      qdit_url: /^https?:\/\//.test(milestone.url) ? milestone.url : null,
      qdit_doc_version: link.doc_version,
      qdit_state: "linked",
    })
    .select(QDIT_LINK_COLUMNS)
    .single();
  if (error || !data) {
    if (error?.code === "23505") {
      throw new LinkingError(409, "That heading or milestone was linked meanwhile.", "HEADING_TAKEN");
    }
    throw new LinkingError(500, `qdit linked the milestone, but doqtri could not record it: ${error?.message ?? "no row"}`);
  }
  return data as QditLinkRow;
}

/**
 * Creates a milestone from a heading (POST /milestones): its title is the
 * heading's text, and it starts `proposed` in the note's project. A retry of
 * a create that reached qdit (409 `node_already_linked`, with the milestone
 * named) takes over that milestone instead of failing.
 */
export async function createMilestoneLink(params: {
  admin: SupabaseClient;
  client: QditClient;
  userId: string;
  doc: LinkableDoc;
  nodeId: string;
  chainVersion: ChainVersion;
}): Promise<QditLinkRow> {
  const { admin, client, userId, doc, nodeId } = params;
  const heading = savedHeading(doc, nodeId);
  const project = await requireProject(admin, doc.id);
  await requireFreeHeading(admin, doc.id, nodeId);
  const docVersion = await chainVersionOf(params.chainVersion, doc.id);

  let milestone: QditMilestone;
  try {
    milestone = await client.createMilestone({
      project_id: project.project_id,
      title: heading.label,
      description: null,
      due_date: null,
      link: { doc_id: doc.id, node_id: nodeId, doc_version: docVersion },
    });
  } catch (error) {
    if (isQdit(error, "conflict", "doc_not_linked")) {
      throw new LinkingError(
        409,
        `qdit says this note isn't linked to ${project.project_name} any more. Unlink the project here and link it again.`,
        "QDIT_DOC_NOT_LINKED",
      );
    }
    const existingId = error instanceof QditError ? error.details?.milestone_id : undefined;
    if (isQdit(error, "conflict", "node_already_linked") && typeof existingId === "string") {
      try {
        milestone = await client.getMilestone(existingId);
      } catch (getError) {
        throw fromQditError(getError);
      }
      if (milestone.link?.doc_id !== doc.id || milestone.link.node_id !== nodeId) {
        throw new LinkingError(409, "qdit already has a milestone on this heading.", "QDIT_CONFLICT");
      }
    } else if (isQdit(error, "conflict", "node_already_linked")) {
      throw new LinkingError(409, "qdit already has a milestone on this heading.", "QDIT_CONFLICT");
    } else {
      throw fromQditError(error);
    }
  }
  if (!milestone.link) {
    throw new LinkingError(502, "qdit created the milestone without its link.", "QDIT_BAD_RESPONSE");
  }

  try {
    return await insertQditRow(admin, { userId, docId: doc.id, heading, milestone, projectId: project.project_id });
  } catch (error) {
    // Someone linked the heading meanwhile: take the new link back out of
    // qdit (the milestone stays; qdit never lets doqtri delete one, D-03).
    if (error instanceof LinkingError && error.code === "HEADING_TAKEN") {
      await client.deleteLink(milestone.link.id).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Links a heading to a milestone that already exists. API v1 has no call
 * that links an unlinked milestone (section 8), so this takes over one that
 * qdit already links to this note, e.g. one whose doqtri row was lost: its
 * link is pointed at the heading (PATCH /links) and its title set to the
 * heading's text (PATCH /milestones, D-12).
 */
export async function adoptMilestoneLink(params: {
  admin: SupabaseClient;
  client: QditClient;
  userId: string;
  doc: LinkableDoc;
  nodeId: string;
  milestoneId: string;
  chainVersion: ChainVersion;
}): Promise<QditLinkRow> {
  const { admin, client, userId, doc, nodeId, milestoneId } = params;
  const heading = savedHeading(doc, nodeId);
  const project = await requireProject(admin, doc.id);
  await requireFreeHeading(admin, doc.id, nodeId);

  let milestone: QditMilestone;
  try {
    milestone = await client.getMilestone(milestoneId);
  } catch (error) {
    throw fromQditError(error);
  }
  if (milestone.project.id !== project.project_id) {
    throw new LinkingError(
      409,
      `That milestone is in ${milestone.project.name}, not ${project.project_name}.`,
      "OTHER_PROJECT",
    );
  }
  if (!milestone.link) {
    throw new LinkingError(
      409,
      "qdit can only link a milestone that was created from Doqtri for now. Create one from this heading instead.",
      "QDIT_UNLINKED_MILESTONE",
    );
  }
  if (milestone.link.doc_id !== doc.id) {
    throw new LinkingError(409, "That milestone is linked to another note.", "OTHER_NOTE");
  }
  const { data: held, error: heldError } = await admin
    .from("node_links")
    .select("node_label")
    .eq("provider", "qdit")
    .eq("qdit_milestone_id", milestone.id)
    .maybeSingle();
  if (heldError) throw new LinkingError(500, `Could not read the note's links: ${heldError.message}`);
  if (held) {
    throw new LinkingError(409, `That milestone is already linked to “${held.node_label}”.`, "ALREADY_LINKED");
  }

  const docVersion = await chainVersionOf(params.chainVersion, doc.id);
  try {
    if (milestone.link.node_id !== nodeId || (docVersion !== null && milestone.link.doc_version !== docVersion)) {
      milestone = await client.updateLink(milestone.link.id, {
        node_id: nodeId,
        ...(docVersion !== null ? { doc_version: docVersion } : {}),
      });
    }
    if (milestone.title !== heading.label) milestone = await client.renameMilestone(milestone.id, heading.label);
  } catch (error) {
    if (isQdit(error, "conflict", "node_already_linked")) {
      throw new LinkingError(409, "qdit already has another milestone on this heading.", "QDIT_CONFLICT");
    }
    throw fromQditError(error);
  }
  if (!milestone.link) throw new LinkingError(502, "qdit answered without the milestone's link.", "QDIT_BAD_RESPONSE");
  return insertQditRow(admin, { userId, docId: doc.id, heading, milestone, projectId: project.project_id });
}

/**
 * Points a qdit link at another heading: how the owner settles an
 * ambiguous, broken or conflicting link, or moves one by hand. doqtri's row
 * changes first (`pending`, with the heading's text as the new label) and
 * syncQditLinks() then tells qdit both the heading and the title.
 */
export async function relinkMilestone(params: {
  admin: SupabaseClient;
  doc: LinkableDoc;
  row: QditLinkRow;
  nodeId: string;
}): Promise<QditLinkRow> {
  const { admin, doc, row, nodeId } = params;
  const heading = savedHeading(doc, nodeId);
  await requireFreeHeading(admin, doc.id, nodeId, row.id);
  const { data, error } = await admin
    .from("node_links")
    .update({ node_id: heading.id, node_label: heading.label, qdit_state: "pending" })
    .eq("id", row.id)
    .eq("provider", "qdit")
    .select(QDIT_LINK_COLUMNS)
    .single();
  if (error || !data) {
    if (error?.code === "23505") throw new LinkingError(409, "That heading already has a link.", "HEADING_TAKEN");
    throw new LinkingError(500, `Could not relink: ${error?.message ?? "no row"}`);
  }
  return data as QditLinkRow;
}

/**
 * Unlinks a heading from its milestone (DELETE /links/{id}). The milestone
 * stays in qdit, and its title becomes editable there again. A 404 is taken
 * as already done only when qdit shows the milestone without that link
 * (section 8); otherwise the row is kept and the failure reported.
 */
export async function unlinkMilestone(params: {
  admin: SupabaseClient;
  client: QditClient;
  row: QditLinkRow;
}): Promise<void> {
  const { admin, client, row } = params;
  try {
    await client.deleteLink(row.qdit_link_id);
  } catch (error) {
    if (!isQdit(error, "not_found")) throw fromQditError(error);
    let gone = false;
    try {
      const milestone = await client.getMilestone(row.qdit_milestone_id);
      gone = !milestone.link || milestone.link.id !== row.qdit_link_id;
    } catch {
      gone = false;
    }
    if (!gone) {
      throw new LinkingError(
        409,
        "qdit didn't confirm the unlink: you may no longer have access to this milestone. The link was kept.",
        "QDIT_UNCONFIRMED",
      );
    }
  }
  const { error } = await admin.from("node_links").delete().eq("id", row.id).eq("provider", "qdit");
  if (error) throw new LinkingError(500, `qdit unlinked the milestone, but doqtri could not record it: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Moves and renames (R-03, D-12, D-21)
// ---------------------------------------------------------------------------

type RemapRow = { id: string; provider: "github" | "qdit"; node_id: string; node_label: string; qdit_state: RemapLink["qditState"] };

/**
 * Remaps the note's links after a save that produced `version` (R-03): moves
 * GitHub and qdit links that followed their heading, renames qdit links whose
 * heading was renamed, and flags the rest, in one version-checked call.
 * `previousMarkdown` is the text the save replaced, when known, which lets
 * structure settle what labels cannot (lib/node-remap.ts).
 *
 * Returns whether any qdit link is now waiting for qdit. Never throws: the
 * save has already happened, and the next one remaps again.
 */
export async function remapAfterSave(
  admin: SupabaseClient,
  params: { docId: string; version: number; title: string; markdown: string; previousMarkdown: string | null },
): Promise<{ changed: number; qditPending: boolean }> {
  const { docId, version, title, markdown, previousMarkdown } = params;
  const { data, error } = await admin
    .from("node_links")
    .select("id, provider, node_id, node_label, qdit_state")
    .eq("document_id", docId);
  if (error) {
    console.warn(`[qdit-linking] links not remapped for ${docId}: ${error.message}`);
    return { changed: 0, qditPending: false };
  }
  const rows = (data ?? []) as RemapRow[];
  if (rows.length === 0) return { changed: 0, qditPending: false };

  const links: RemapLink[] = rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    nodeId: r.node_id,
    nodeLabel: r.node_label,
    qditState: r.qdit_state,
  }));
  const before = previousMarkdown === null ? null : headingsOf(title, previousMarkdown);
  const changes = remapChanges(links, planRemap(links, headingsOf(title, markdown), before));
  const alreadyPending = rows.some((r) => r.provider === "qdit" && r.qdit_state === "pending");
  if (changes.length === 0) return { changed: 0, qditPending: alreadyPending };

  const { data: changed, error: applyError } = await admin.rpc("apply_node_link_remap", {
    p_document_id: docId,
    p_version: version,
    p_changes: changes,
  });
  if (applyError) {
    console.warn(`[qdit-linking] links not remapped for ${docId}: ${applyError.message}`);
    return { changed: 0, qditPending: alreadyPending };
  }
  if (changed === null) {
    // Saved again since: that save remaps from the newer text.
    return { changed: 0, qditPending: alreadyPending };
  }
  const nowPending = changes.some((c) => c.qdit_state === "pending");
  return { changed: Number(changed) || 0, qditPending: alreadyPending || nowPending };
}

export type SyncResult = {
  /** Another sync of this note was running; it picks up these changes. */
  skipped: boolean;
  /** Links qdit now agrees with. */
  synced: number;
  /** Links still waiting, with why. */
  failed: { id: string; message: string }[];
};

/** Rounds of reading pending rows per sync; a heading typed into keeps it busy at most this long. */
const MAX_ROUNDS = 4;
const LEASE_SECONDS = 60;

/**
 * Tells qdit where each `pending` link points now and what its title is
 * (PATCH /links/{id}, then PATCH /milestones/{id} when the title differs,
 * D-21, D-12), and marks it `linked` once qdit agrees, unless the row
 * changed again meanwhile.
 *
 * One sync per note at a time (claim_qdit_link_sync): without it, two saves
 * in quick succession could reach qdit out of order and leave it with the
 * older title. A sync that finds the lease taken stops at once; the holder
 * reads the rows again before letting go, and once more after, so a change
 * written while it ran is not left behind.
 *
 * qdit refuses to put two milestones on one heading (409
 * `node_already_linked`), and when headings move past each other it may
 * still hold another of this note's links where this one is going: that
 * link is moved first, and in a cycle (two headings swapped) one link steps
 * aside to an id past the last heading for a moment.
 */
export async function syncQditLinks(params: {
  admin: SupabaseClient;
  client: QditClient;
  docId: string;
  chainVersion: ChainVersion;
}): Promise<SyncResult> {
  const { admin, docId } = params;
  const lease = randomUUID();
  const claim = async () => {
    const { data, error } = await admin.rpc("claim_qdit_link_sync", {
      p_document_id: docId,
      p_lease: lease,
      p_seconds: LEASE_SECONDS,
    });
    return !error && data === true;
  };
  const release = async () => {
    await admin.rpc("release_qdit_link_sync", { p_document_id: docId, p_lease: lease });
  };

  const result: SyncResult = { skipped: false, synced: 0, failed: [] };
  if (!(await claim())) return { ...result, skipped: true };

  let docVersion: number | null | undefined;
  const version = async () => (docVersion ??= await chainVersionOf(params.chainVersion, docId));
  // What failed this sync, as it stood then: tried again only once changed.
  const failedAs = new Map<string, string>();
  const asKey = (r: QditLinkRow) => `${r.node_id}\u0000${r.node_label}`;
  const waiting = async () =>
    (await loadQditLinks(admin, docId)).filter(
      (r) => r.qdit_state === "pending" && failedAs.get(r.id) !== asKey(r),
    );

  let held = true;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const rows = await loadQditLinks(admin, docId);
      const pending = rows.filter((r) => r.qdit_state === "pending" && failedAs.get(r.id) !== asKey(r));
      if (pending.length === 0) {
        // Let go, then look once more: a sync turned away meanwhile wrote
        // its rows before it tried the lease.
        await release();
        held = false;
        if ((await waiting()).length === 0 || !(await claim())) break;
        held = true;
        continue;
      }
      const outcome = await pushRound(params, rows, pending, await version());
      result.synced += outcome.synced;
      for (const f of outcome.failed) {
        const row = pending.find((r) => r.id === f.id);
        if (row) failedAs.set(row.id, asKey(row));
        result.failed = [...result.failed.filter((x) => x.id !== f.id), f];
      }
      if (!(await claim())) {
        held = false;
        break;
      }
    }
  } finally {
    if (held) await release();
  }
  return result;
}

async function pushRound(
  params: { admin: SupabaseClient; client: QditClient; docId: string },
  rows: QditLinkRow[],
  pending: QditLinkRow[],
  docVersion: number | null,
): Promise<{ synced: number; failed: { id: string; message: string }[] }> {
  const { admin, client } = params;
  const byMilestone = new Map(rows.map((r) => [r.qdit_milestone_id, r]));
  const pendingIds = new Set(pending.map((r) => r.id));
  const placed = new Map<string, QditMilestone>();
  const stepAside = new Set<string>();
  const failed: { id: string; message: string }[] = [];
  const fail = (row: QditLinkRow, message: string) => {
    if (!failed.some((f) => f.id === row.id)) failed.push({ id: row.id, message });
  };
  // Where a link steps aside in qdit for a moment: far past every id this
  // note's links use, so no link qdit holds for the note is there.
  let nextPark = Math.max(0, ...rows.map((r) => Number(/^h(\d+)$/.exec(r.node_id)?.[1] ?? -1))) + 1000;

  async function setState(row: QditLinkRow, state: "broken" | "conflict") {
    await admin
      .from("node_links")
      .update({ qdit_state: state })
      .eq("id", row.id)
      .eq("node_id", row.node_id)
      .eq("node_label", row.node_label)
      .eq("qdit_state", "pending");
  }

  /** Puts qdit's copy of `row` at row.node_id. True once it is there. */
  async function place(row: QditLinkRow, waiting: Set<string>): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = {
        node_id: row.node_id,
        ...(pendingIds.has(row.id) && docVersion !== null && docVersion !== row.qdit_doc_version
          ? { doc_version: docVersion }
          : {}),
      };
      try {
        placed.set(row.id, await client.updateLink(row.qdit_link_id, body));
        return true;
      } catch (error) {
        if (error instanceof QditError && error.kind === "conflict" && error.reason === "node_already_linked") {
          const holderId = typeof error.details?.milestone_id === "string" ? error.details.milestone_id : null;
          const holder = holderId ? byMilestone.get(holderId) : undefined;
          if (!holder || holder.id === row.id) {
            if (pendingIds.has(row.id)) await setState(row, "conflict");
            fail(row, "qdit already has another milestone on this heading.");
            return false;
          }
          if (waiting.has(holder.id)) {
            // A cycle: the holder is waiting for this link's place. Step
            // aside so it can move, and come back after.
            await client.updateLink(row.qdit_link_id, { node_id: `h${nextPark++}` });
            stepAside.add(row.id);
            return false;
          }
          const moved = await place(holder, new Set([...waiting, row.id]));
          if (!moved && !stepAside.has(holder.id)) {
            fail(row, "Another link is still on this heading in qdit.");
            return false;
          }
          continue;
        }
        if (error instanceof QditError && error.kind === "not_found") {
          // Gone from qdit, or out of this user's sight: only the first is broken.
          let gone = false;
          try {
            const milestone = await client.getMilestone(row.qdit_milestone_id);
            gone = !milestone.link || milestone.link.id !== row.qdit_link_id;
          } catch {
            gone = false;
          }
          if (gone && pendingIds.has(row.id)) await setState(row, "broken");
          fail(row, gone ? "qdit no longer has this link." : "You can't see this milestone in qdit.");
          return false;
        }
        throw error;
      }
    }
    fail(row, "qdit kept refusing the move.");
    return false;
  }

  try {
    for (const row of pending) {
      if (!placed.has(row.id)) await place(row, new Set());
    }
    for (const id of stepAside) {
      const row = rows.find((r) => r.id === id)!;
      await place(row, new Set());
    }
  } catch (error) {
    // Not connected, rate limited, unreachable: nothing else will work now.
    const message = fromQditError(error).message;
    for (const row of pending) if (!placed.has(row.id)) fail(row, message);
  }

  let synced = 0;
  for (const row of pending) {
    let milestone = placed.get(row.id);
    if (!milestone) continue;
    try {
      if (milestone.title !== row.node_label) milestone = await client.renameMilestone(row.qdit_milestone_id, row.node_label);
    } catch (error) {
      if (isQdit(error, "conflict", "milestone_not_linked")) {
        await setState(row, "broken");
        fail(row, "qdit no longer has this link.");
      } else {
        fail(row, fromQditError(error).message);
      }
      continue;
    }
    // Only if nothing changed the row while qdit was being told.
    const { data } = await admin
      .from("node_links")
      .update({
        qdit_state: "linked",
        qdit_doc_version: milestone.link?.doc_version ?? row.qdit_doc_version,
        qdit_url: /^https?:\/\//.test(milestone.url) ? milestone.url : row.qdit_url,
      })
      .eq("id", row.id)
      .eq("node_id", row.node_id)
      .eq("node_label", row.node_label)
      .eq("qdit_state", "pending")
      .select("id");
    if ((data ?? []).length > 0) synced += 1;
  }
  return { synced, failed };
}
