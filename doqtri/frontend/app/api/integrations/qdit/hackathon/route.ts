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
import { buildHackathonSnapshot, HackathonSnapshotError } from "@/lib/integrations/qdit-hackathon";
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
 * Answers `{ ok: true, note_count, submission_state, qdit_url, warnings }`,
 * or `{ ok: false, code, message }` with a sentence for the dialog. Never
 * logs note content.
 */

const reply = (status: number, body: HackathonSendResponse, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

const refuse = (status: number, code: HackathonSendCode, message: string, headers?: Record<string, string>) =>
  reply(status, { ok: false, code, message }, headers);

/** The answer for a failed push. */
function pushFailure(error: unknown): NextResponse {
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
  const origin = qditPublicOrigin();

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

  let built: Awaited<ReturnType<typeof buildHackathonSnapshot>>;
  try {
    built = await buildHackathonSnapshot({
      supabase,
      sourceClient: createSupabaseAdminClient(),
      workspaceId: workspace.id,
      hackathonSlug: slug,
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

  let receipt: QditHackathonSnapshotReceipt;
  try {
    receipt = await createQditClient(user.id, { config: setup.config, store: setup.store }).pushHackathonSnapshot(
      projectId,
      built.body,
    );
  } catch (error) {
    return pushFailure(error);
  }

  return reply(200, {
    ok: true,
    note_count: receipt.note_count,
    submission_state: receipt.submission_state,
    qdit_url: hackathonUrl(origin, slug),
    warnings: built.warnings,
  });
}
