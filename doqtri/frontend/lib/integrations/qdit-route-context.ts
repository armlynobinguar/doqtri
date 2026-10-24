import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { DoqtriRegistry } from "@/lib/stellar/contract-client";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { createQditClient, qditServerSetup, type QditClient } from "@/lib/integrations/qdit-client";
import { LinkingError, type ChainVersion } from "@/lib/integrations/qdit-linking";
import { loadMemberDocument, type WorkspaceRole } from "@/lib/workspace-docs";

/**
 * What every qdit linking route needs before it acts (WP-2.5; server-only):
 * the integration on, a signed-in user, the note loaded through the service
 * role only for a member of its workspace holding `minRole` (admin or owner
 * for the note's project, D-10; editor for its headings), and the user's
 * qdit client. Anything missing is answered here, so a route cannot forget
 * a check.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LinkingDoc = { id: string; workspace_id: string; title: string; markdown: string };

export type QditRouteContext = {
  userId: string;
  admin: SupabaseClient;
  client: QditClient;
  doc: LinkingDoc;
  chainVersion: ChainVersion;
};

/** The note's DoqtriRegistry version, or null when it was never anchored. */
export const registryVersion: ChainVersion = async (docId) =>
  (await DoqtriRegistry.getDocument(docId))?.version ?? null;

const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The answer for a LinkingError, or for anything else thrown. */
export function linkingErrorResponse(error: unknown): NextResponse {
  if (error instanceof LinkingError) {
    const response = json(error.status, { error: error.message, code: error.code });
    if (error.retryAfterSeconds !== null) response.headers.set("Retry-After", String(error.retryAfterSeconds));
    return response;
  }
  console.error(`[qdit-linking] ${error instanceof Error ? error.message : String(error)}`);
  return json(500, { error: "Something went wrong linking to qdit." });
}

const FORBIDDEN: Partial<Record<WorkspaceRole, string>> = {
  admin: "Only an admin or owner of this workspace can link the note to a qdit project.",
  editor: "You can read this note but not change its links.",
};

export async function qditRouteContext(
  docId: string,
  minRole: WorkspaceRole,
): Promise<{ ok: true; ctx: QditRouteContext } | { ok: false; response: NextResponse }> {
  if (!qditIntegrationEnabled()) return { ok: false, response: json(404, { error: "Not found" }) };

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: json(401, { error: "Not signed in" }) };
  if (!isUuid(docId)) return { ok: false, response: json(404, { error: "Note not found" }) };

  const admin = createSupabaseAdminClient();
  const found = await loadMemberDocument<{ title: string; markdown: string }>(admin, {
    userId: user.id,
    docId,
    minRole,
    columns: "title, markdown",
  });
  if (!found.ok) {
    if (found.reason === "error") return { ok: false, response: json(500, { error: found.message }) };
    if (found.reason === "forbidden") {
      return {
        ok: false,
        response: json(403, { error: FORBIDDEN[minRole] ?? "Your role doesn't allow this.", code: "FORBIDDEN" }),
      };
    }
    return { ok: false, response: json(404, { error: "Note not found" }) };
  }

  const setup = qditServerSetup();
  if (!setup) {
    return {
      ok: false,
      response: json(503, { error: "qdit isn't set up on this deployment.", code: "QDIT_NOT_CONFIGURED" }),
    };
  }

  return {
    ok: true,
    ctx: {
      userId: user.id,
      admin,
      client: createQditClient(user.id, { config: setup.config, store: setup.store }),
      doc: {
        id: found.doc.id,
        workspace_id: found.doc.workspace_id,
        title: found.doc.title ?? "",
        markdown: found.doc.markdown ?? "",
      },
      chainVersion: registryVersion,
    },
  };
}

/** The request's JSON body as an object, or null. */
export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export { json as noStoreJson };
