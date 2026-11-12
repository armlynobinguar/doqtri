import { NextResponse } from "next/server";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { readActiveWorkspaceCookie, resolveActiveWorkspace } from "@/lib/active-workspace";
import { roleAtLeast } from "@/lib/workspace-roles";
import { qditHackathonEnabled, qditPublicOrigin } from "@/lib/integrations/qdit-config";
import {
  createQditClient,
  QditError,
  QditHackathonSnapshotError,
  QditNotConnectedError,
  qditServerSetup,
  type QditHackathonSnapshotReceipt,
} from "@/lib/integrations/qdit-client";
import { buildHackathonSnapshot, HackathonSnapshotError, withMindmapUrl } from "@/lib/integrations/qdit-hackathon";
import { loadMindmapStyle } from "@/lib/load-mindmap-style";
import { MINDMAP_SHARE_COPY, mindmapShareUrl } from "@/lib/mindmap-share";
import {
  hiddenNodeIds,
  insertMindmapShare,
  newShareToken,
  revokeMindmapShareAsServer,
  shareStyle,
} from "@/lib/mindmap-share-server";
import { SITE_URL } from "@/lib/site-url";
import {
  HACKATHON_SEND_COPY as COPY,
  hackathonUrl,
  parseHackathonInput,
  type HackathonSendCode,
  type HackathonSendResponse,
} from "@/lib/integrations/qdit-hackathon-send";
import { isUuid, readBody } from "@/lib/integrations/qdit-route-context";

/**
 * "Send to qdit hackathon" (WP-4.7, D-117): POST `{ hackathon, project_id,
 * workspace_id? }` sends a snapshot of the active workspace's notes and its
 * global mindmap to `project_id`'s entry in the qdit hackathon `hackathon`
 * (a slug, or a qdit link to the hackathon's page).
 *
 * Only an admin or owner of the active workspace sends (D-10), with their own
 * qdit connection; qdit then asks that they administer the project. The
 * snapshot is built here from doqtri's database (the session client, so RLS
 * decides which notes; the service role only to recognize teammates'
 * imports), never from the request. `workspace_id`, when sent, must still be
 * the active workspace: a switch in another tab is refused rather than
 * sending another workspace's notes.
 *
 * One snapshot, so one snapshot_id, per request (one press of Send). Nothing
 * here retries; the client's own 401 refresh resends the same bytes.
 *
 * Each press also makes one public read-only link to the global mindmap as
 * sent (WP-4.7, DOQ-53): the share row (graph and the sender's `global`
 * style, under a new token) is stored first, then `mindmap_url` goes into the
 * snapshot before it is serialized, so the bytes qdit hashes, and any resend
 * of them, carry that one link. A push qdit definitely refused revokes the
 * link again, so no link qdit never got stays live; a push that got no
 * answer (QDIT_UNCERTAIN) keeps it, since qdit may have stored it (DOQ-54),
 * and the dialog lists it with Revoke. Where no link can be made (the site is
 * not https, or the row could not be stored) the snapshot goes without one,
 * as before, and a warning says so.
 *
 * The link names its hackathon, so it expires 24 hours after that
 * hackathon's grades are released (DOQ-54, the `hackathon.released`
 * webhook). Nodes the sender hid in their `global` style are left out of the
 * snapshot, and so of the stored link, with their links (DOQ-54): the style
 * is read before the snapshot is built, and a send whose style cannot be
 * read is refused rather than sending what they hid.
 *
 * Answers `{ ok: true, note_count, submission_state, qdit_url, mindmap_url, warnings }`,
 * or `{ ok: false, code, message }` with a sentence for the dialog. Never
 * logs note content.
 */

const reply = (status: number, body: HackathonSendResponse, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

const refuse = (status: number, code: HackathonSendCode, message: string, headers?: Record<string, string>) =>
  reply(status, { ok: false, code, message }, headers);

/** Whether qdit refused only the `mindmap_url` field as unknown: a qdit before contract v1.4.0. */
function refusedOnlyTheLinkField(error: unknown): boolean {
  return (
    error instanceof QditHackathonSnapshotError &&
    error.refusal === "invalid_snapshot" &&
    error.status === 400 &&
    error.fields.length === 1 &&
    error.fields[0] === "mindmap_url" &&
    error.fieldProblems.mindmap_url === "unknown field"
  );
}

/** No answer from qdit (QDIT_UNCERTAIN): it may have stored the snapshot. */
function noAnswer(error: unknown): boolean {
  return error instanceof QditError && (error.kind === "network" || error.kind === "timeout");
}

/**
 * The answer for a failed push; `qditUrl` is the hackathon's page in qdit.
 * `linkKept`: no answer left this press's mindmap link live, and the message
 * says where to revoke it.
 */
function pushFailure(error: unknown, qditUrl: string | null, linkKept = false): NextResponse {
  if (error instanceof QditHackathonSnapshotError) {
    switch (error.refusal) {
      case "hackathon_closed":
        return refuse(409, "HACKATHON_CLOSED", COPY.closed);
      case "hackathon_not_open":
        return refuse(409, "HACKATHON_NOT_OPEN", COPY.notOpen);
      case "snapshot_limit":
        return refuse(409, "SNAPSHOT_LIMIT", COPY.snapshotLimit);
      case "snapshot_conflict":
        return refuse(409, "SNAPSHOT_CONFLICT", COPY.conflict);
      case "forbidden":
        // Below admin on the project, or doqtri's client not the one qdit
        // expects (D-61): the copy covers both, the log only the kind.
        console.warn("[qdit-hackathon] push refused: kind=forbidden");
        return refuse(403, "QDIT_FORBIDDEN", COPY.qditForbidden);
      case "not_found":
        return refuse(404, "QDIT_NOT_FOUND", COPY.notFound);
      case "too_large":
        return refuse(413, "TOO_LARGE", COPY.tooLarge(error.fields[0] ?? "body"));
      case "invalid_snapshot":
        console.warn(`[qdit-hackathon] qdit refused the snapshot: ${error.fields.join(", ") || "no fields"}`);
        return refuse(
          400,
          "QDIT_REFUSED",
          `qdit didn't accept the snapshot${error.fields.length ? ` (${error.fields.join(", ")})` : ""}`,
        );
    }
  }
  if (error instanceof QditNotConnectedError) return refuse(409, "QDIT_NOT_CONNECTED", error.message);
  if (error instanceof QditError) {
    if (error.kind === "not_configured") return refuse(503, "QDIT_NOT_CONFIGURED", COPY.notConfigured);
    if (error.kind === "rate_limited") {
      return refuse(
        429,
        "QDIT_RATE_LIMITED",
        COPY.rateLimited,
        error.retryAfterSeconds !== null ? { "Retry-After": String(error.retryAfterSeconds) } : undefined,
      );
    }
    if (noAnswer(error)) {
      // No answer: qdit may have stored it. Nothing retries here, and a new
      // press sends a new snapshot_id, so the user checks qdit first.
      console.error(`[qdit-hackathon] push got no answer: kind=${error.kind}`);
      const message = linkKept ? `${COPY.uncertain} ${MINDMAP_SHARE_COPY.keptAfterNoAnswer}` : COPY.uncertain;
      return reply(502, { ok: false, code: "QDIT_UNCERTAIN", message, qdit_url: qditUrl });
    }
    // Kind, status and request id only: qdit's text is not logged.
    console.error(
      `[qdit-hackathon] push failed: ${error.kind} ${error.status ?? "-"} request ${error.requestId ?? "-"}`,
    );
    return refuse(502, "QDIT_UNAVAILABLE", COPY.unavailable);
  }
  console.error(`[qdit-hackathon] push failed: ${error instanceof Error ? error.name : "unknown error"}`);
  return refuse(502, "QDIT_UNAVAILABLE", COPY.unavailable);
}

export async function POST(request: Request) {
  if (!qditHackathonEnabled()) return refuse(404, "NOT_FOUND", "Not found");

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return refuse(401, "NOT_SIGNED_IN", "Not signed in");

  let workspace;
  try {
    ({ active: workspace } = await resolveActiveWorkspace(supabase, user.id, await readActiveWorkspaceCookie(user.id)));
  } catch (error) {
    console.error(`[qdit-hackathon] ${(error as Error).message}`);
    return refuse(500, "FAILED", COPY.failed);
  }
  if (!roleAtLeast(workspace.role, "admin")) return refuse(403, "FORBIDDEN", COPY.forbidden);

  const setup = qditServerSetup();
  if (!setup) return refuse(503, "QDIT_NOT_CONFIGURED", COPY.notConfigured);
  // Links are checked against qdit's origin, and the dialog links back to it.
  const origin = qditPublicOrigin();
  if (!origin) return refuse(503, "QDIT_NOT_CONFIGURED", COPY.notConfigured);

  const body = await readBody(request);
  if (!body || !isUuid(body.project_id)) return refuse(400, "BAD_REQUEST", COPY.pickProject);
  const slug = parseHackathonInput(body.hackathon, origin);
  if (!slug) return refuse(400, "BAD_HACKATHON_LINK", COPY.badLink);
  if (body.workspace_id !== undefined && body.workspace_id !== workspace.id) {
    return refuse(409, "WORKSPACE_CHANGED", COPY.workspaceChanged);
  }
  const projectId = body.project_id.toLowerCase();

  // Before building: a user with no usable connection is told so, not made
  // to wait for a snapshot that cannot be sent.
  let connection;
  try {
    connection = await setup.store.load(user.id);
  } catch (error) {
    console.error(`[qdit-hackathon] loading the qdit connection failed: ${(error as Error).message}`);
    return refuse(500, "FAILED", COPY.failed);
  }
  if (connection?.status !== "connected") {
    return refuse(409, "QDIT_NOT_CONNECTED", new QditNotConnectedError(connection?.status ?? "none").message);
  }

  // The sender's global style: what they hid is left out (DOQ-54), and the
  // link shows the map in their look.
  const saved = await loadMindmapStyle(supabase, user.id, "global");
  if (!saved.loaded) {
    console.error("[qdit-hackathon] the sender's global mindmap style could not be read");
    return refuse(500, "FAILED", COPY.failed);
  }

  let built: Awaited<ReturnType<typeof buildHackathonSnapshot>>;
  try {
    built = await buildHackathonSnapshot({
      supabase,
      sourceClient: createSupabaseAdminClient(),
      workspaceId: workspace.id,
      hackathonSlug: slug,
      hiddenNodeIds: hiddenNodeIds(saved.style),
    });
  } catch (error) {
    if (error instanceof HackathonSnapshotError) {
      // The slug was checked above; anything else is a note or the whole
      // body over a contract limit, so nothing was sent (D-118).
      if (error.field === "hackathon_slug") return refuse(400, "BAD_HACKATHON_LINK", COPY.badLink);
      return refuse(413, "TOO_LARGE", COPY.tooLarge(error.field));
    }
    console.error(`[qdit-hackathon] building the snapshot failed: ${(error as Error).message}`);
    return refuse(500, "FAILED", COPY.failed);
  }

  // The public link. Its row is written before the link goes into the body,
  // so qdit can never hold a link that leads nowhere.
  let sendBody = built.body;
  let mindmapUrl: string | null = null;
  let shareId: string | null = null;
  const warnings = [...built.warnings];
  const token = newShareToken();
  const url = mindmapShareUrl(SITE_URL, token);
  if (url) {
    try {
      const sourceClient = createSupabaseAdminClient();
      const linked = withMindmapUrl(built.snapshot, url);
      shareId = await insertMindmapShare(sourceClient, {
        token,
        workspaceId: workspace.id,
        createdBy: user.id,
        snapshotId: built.snapshot.snapshot_id,
        hackathonSlug: slug,
        graph: built.snapshot.global_mindmap,
        style: shareStyle(saved.style, built.snapshot.global_mindmap),
      });
      sendBody = linked.body;
      mindmapUrl = url;
    } catch (error) {
      // Sent without a link rather than not at all: the images in qdit are
      // still the entry's required proof (QDIT-66).
      console.error(
        `[qdit-hackathon] no mindmap link: ${error instanceof HackathonSnapshotError ? error.field : (error as Error).message}`,
      );
      warnings.push(MINDMAP_SHARE_COPY.noLink);
    }
  } else {
    warnings.push(MINDMAP_SHARE_COPY.noLink);
  }

  const client = createQditClient(user.id, { config: setup.config, store: setup.store });
  let receipt: QditHackathonSnapshotReceipt;
  try {
    try {
      receipt = await client.pushHackathonSnapshot(projectId, sendBody);
    } catch (error) {
      // A qdit older than contract v1.4.0 refuses the field itself, with
      // exactly 400 {"mindmap_url": "unknown field"}. A 400 stores nothing,
      // so the same snapshot goes again without it (the contract's MAY,
      // section 8): the bytes the builder made first, same snapshot_id.
      if (!shareId || !refusedOnlyTheLinkField(error)) throw error;
      console.warn("[qdit-hackathon] qdit does not take mindmap_url yet; sending without it");
      const revoked = await revokeMindmapShareAsServer(createSupabaseAdminClient(), shareId);
      if (!revoked) console.error("[qdit-hackathon] the unsent mindmap link could not be revoked");
      shareId = null;
      mindmapUrl = null;
      warnings.push(MINDMAP_SHARE_COPY.noLink);
      receipt = await client.pushHackathonSnapshot(projectId, built.body);
    }
  } catch (error) {
    // A definite refusal revokes, so no link qdit never got stays live
    // (DOQ-53). No answer (QDIT_UNCERTAIN) keeps it (DOQ-54): qdit may have
    // stored the snapshot, and with it the link. The dialog lists it with
    // Revoke, and it expires with the hackathon either way.
    if (shareId && !noAnswer(error) && !(await revokeMindmapShareAsServer(createSupabaseAdminClient(), shareId))) {
      console.error("[qdit-hackathon] the failed push's mindmap link could not be revoked");
    }
    return pushFailure(error, hackathonUrl(origin, slug), shareId !== null && noAnswer(error));
  }

  return reply(200, {
    ok: true,
    note_count: receipt.note_count,
    submission_state: receipt.submission_state,
    qdit_url: hackathonUrl(origin, slug),
    mindmap_url: mindmapUrl,
    warnings,
  });
}
