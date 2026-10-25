import { cache } from "react";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { personalWorkspaceId } from "@/lib/workspace-docs";
import { isFormerPersonalWorkspace } from "@/lib/former-user";
import { roleAtLeast, type WorkspaceRole } from "@/lib/workspace-roles";
import {
  ACTIVE_WORKSPACE_COOKIE,
  isWorkspaceId,
  parseActiveWorkspace,
  pickActiveWorkspace,
  sortWorkspaces,
  switchWorkspaceUrl,
  type WorkspaceChoice,
} from "@/lib/workspace-scope";

/**
 * The vault's active workspace on the server (WP-1.7): which one the pages
 * load, and which one a new note, template copy or import goes into. See
 * lib/workspace-scope.ts for the rules; this file adds the reads.
 *
 * Server-only: it reads cookies and, through personalWorkspaceId(), may use
 * the admin client to repair a missing personal workspace.
 */

export type ActiveWorkspace = {
  /** The workspace the vault shows. */
  active: WorkspaceChoice;
  /** Every workspace the user belongs to, for the switcher. */
  workspaces: WorkspaceChoice[];
};

type MembershipRow = {
  role: WorkspaceRole;
  workspaces: { id: string; name: string; is_personal: boolean; created_by: string | null } | null;
};

/**
 * Every workspace `userId` belongs to, with their role in it, their own
 * personal workspace first. `client` may be a session client (RLS shows a
 * member their own rows and their workspaces) or the admin client; either
 * way the rows are filtered to `userId`, which must come from a verified
 * session.
 */
export async function listMyWorkspaces(client: SupabaseClient, userId: string): Promise<WorkspaceChoice[]> {
  const { data, error } = await client
    .from("workspace_members")
    .select("role, workspaces(id, name, is_personal, created_by)")
    .eq("user_id", userId);
  if (error) throw new Error(`Could not load your workspaces: ${error.message}`);

  const choices: WorkspaceChoice[] = [];
  for (const row of (data ?? []) as unknown as MembershipRow[]) {
    const w = Array.isArray(row.workspaces) ? row.workspaces[0] : row.workspaces;
    if (!w) continue;
    choices.push({
      id: w.id,
      name: w.name,
      personal: Boolean(w.is_personal),
      role: row.role,
      mine: w.created_by === userId,
      former: isFormerPersonalWorkspace(w),
    });
  }
  return sortWorkspaces(choices);
}

/**
 * The workspace to show `userId`: `requestedId` while they are still a
 * member of it, otherwise their personal workspace, which is repaired first
 * should it be missing.
 */
export async function resolveActiveWorkspace(
  client: SupabaseClient,
  userId: string,
  requestedId: string | null,
): Promise<ActiveWorkspace> {
  let workspaces = await listMyWorkspaces(client, userId);
  let active = pickActiveWorkspace(workspaces, requestedId);
  if (!active) {
    // No personal workspace in the list: make sure there is one, then look again.
    await personalWorkspaceId(client, userId);
    workspaces = await listMyWorkspaces(client, userId);
    active = pickActiveWorkspace(workspaces, requestedId);
    if (!active) throw new Error("Could not load your workspace");
  }
  return { active, workspaces };
}

/** The workspace this browser last chose for `userId`, unchecked. */
export async function readActiveWorkspaceCookie(userId: string): Promise<string | null> {
  return parseActiveWorkspace((await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value, userId);
}

/**
 * The active workspace for the signed-in `userId`, for server components.
 * Cached per request, so the vault layout and the page inside it make one
 * set of reads between them.
 */
export const getActiveWorkspace = cache(async (userId: string): Promise<ActiveWorkspace> => {
  const supabase = await createSupabaseServerClient();
  return resolveActiveWorkspace(supabase, userId, await readActiveWorkspaceCookie(userId));
});

export type CreateTarget =
  | { ok: true; workspaceId: string }
  | { ok: false; status: 403 | 404 | 500; error: string };

/**
 * Where a note created by `userId` goes: the workspace the request names
 * (the one the user's vault was showing when they asked), else the one this
 * browser has active, else their personal workspace. Only editors and above
 * may add notes (D-14): a viewer is refused rather than having the note
 * quietly land somewhere they were not looking.
 *
 * Runs with the admin client, so the membership is checked here. A
 * workspace named in the request that the user is not in is refused as not
 * found; a stale cookie falls back to the personal workspace.
 */
export async function workspaceForCreate(
  admin: SupabaseClient,
  userId: string,
  params: { requested?: unknown; cookie?: string | null },
): Promise<CreateTarget> {
  const explicit = isWorkspaceId(params.requested) ? params.requested : null;
  const candidate = explicit ?? params.cookie ?? null;

  if (candidate) {
    const { data, error } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", candidate)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return { ok: false, status: 500, error: `Could not load your workspace: ${error.message}` };
    const role = (data?.role as WorkspaceRole | undefined) ?? null;
    if (role) {
      if (!roleAtLeast(role, "editor")) {
        return {
          ok: false,
          status: 403,
          error: "You're a viewer in this workspace, so you can't add notes to it. Switch workspace first.",
        };
      }
      return { ok: true, workspaceId: candidate };
    }
    if (explicit) return { ok: false, status: 404, error: "That workspace isn't one of yours." };
  }

  try {
    return { ok: true, workspaceId: await personalWorkspaceId(admin, userId) };
  } catch (error) {
    return { ok: false, status: 500, error: (error as Error).message };
  }
}

/**
 * For a note page asked for a note outside the active workspace: the link
 * that switches to the note's workspace and comes back, when the user can
 * read the note there; null when they cannot (the page is then a 404, as
 * before). RLS decides "can read", through the session client.
 */
export async function crossWorkspaceRedirect(
  supabase: SupabaseClient,
  params: { docId: string; activeId: string; next: string },
): Promise<string | null> {
  if (!isWorkspaceId(params.docId)) return null;
  const { data } = await supabase
    .from("documents")
    .select("workspace_id")
    .eq("id", params.docId)
    .maybeSingle();
  const workspaceId = (data?.workspace_id as string | undefined) ?? null;
  if (!workspaceId || workspaceId === params.activeId) return null;
  return switchWorkspaceUrl(workspaceId, params.next);
}
