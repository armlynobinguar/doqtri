import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { uniqueTitle } from "@/lib/title";
import { roleAtLeast, type WorkspaceRole } from "@/lib/workspace-roles";

/**
 * Documents belong to workspaces (WP-1.2). These are the server-side helpers
 * every route that reads or writes a document through the service role uses,
 * so none of them can forget the workspace check the service role skips.
 *
 * Server-only: it imports the admin client.
 */

export { roleAtLeast, type WorkspaceRole } from "@/lib/workspace-roles";

/**
 * The user's personal workspace, where their notes go until WP-1.7 adds a
 * workspace switcher. Every account has one (a trigger on auth.users makes
 * it); should one be missing or have lost its owner row, it is repaired
 * through ensure_personal_workspace(), which only the service role may call.
 *
 * `client` may be a session client: the caller owns the workspace, so RLS
 * shows it to them. `userId` must come from a verified session.
 */
export async function personalWorkspaceId(client: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await client
    .from("workspaces")
    .select("id")
    .eq("created_by", userId)
    .eq("is_personal", true)
    .maybeSingle();
  if (error) throw new Error(`Could not load your workspace: ${error.message}`);
  if (data?.id) return data.id as string;

  const { data: repaired, error: repairError } = await createSupabaseAdminClient().rpc(
    "ensure_personal_workspace",
    { p_user_id: userId },
  );
  if (repairError || typeof repaired !== "string") {
    throw new Error(`Could not load your workspace: ${repairError?.message ?? "no workspace"}`);
  }
  return repaired;
}

/** A document row with the columns that decide who may touch it. */
export type MemberDocument<T> = T & { id: string; workspace_id: string; user_id: string | null };

export type MemberDocumentResult<T> =
  | { ok: true; doc: MemberDocument<T>; role: WorkspaceRole }
  | MemberDocumentRefusal;

/** Why loadMemberDocument() returned no document. */
export type MemberDocumentRefusal =
  /** Not found, or in a workspace the user is not in: indistinguishable on purpose. */
  | { ok: false; reason: "not_found" }
  /** The user can see it but their role is below `minRole`. */
  | { ok: false; reason: "forbidden"; role: WorkspaceRole }
  | { ok: false; reason: "error"; message: string };

/**
 * Loads a document through the service role, but only for a member of its
 * workspace holding at least `minRole`: the same rule RLS applies to session
 * clients (viewer reads; editor writes and deletes).
 */
export async function loadMemberDocument<T extends object = object>(
  admin: SupabaseClient,
  params: { userId: string; docId: string; columns?: string; minRole: WorkspaceRole },
): Promise<MemberDocumentResult<T>> {
  const { userId, docId, columns, minRole } = params;
  const select = ["id", "workspace_id", "user_id", columns].filter(Boolean).join(", ");

  const { data: doc, error } = await admin
    .from("documents")
    .select(select)
    .eq("id", docId)
    .maybeSingle();
  if (error) return { ok: false, reason: "error", message: error.message };
  if (!doc) return { ok: false, reason: "not_found" };

  const row = doc as unknown as MemberDocument<T>;
  const { data: member, error: memberError } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", row.workspace_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) return { ok: false, reason: "error", message: memberError.message };
  if (!member) return { ok: false, reason: "not_found" };

  const role = member.role as WorkspaceRole;
  if (!roleAtLeast(role, minRole)) return { ok: false, reason: "forbidden", role };
  return { ok: true, doc: row, role };
}

/** Every title in one workspace, for uniqueTitle() and isTitleTaken(). */
export async function workspaceTitles(
  admin: SupabaseClient,
  workspaceId: string,
  options: { excludeId?: string } = {},
): Promise<{ titles: string[]; error: string | null }> {
  let query = admin.from("documents").select("title").eq("workspace_id", workspaceId);
  if (options.excludeId) query = query.neq("id", options.excludeId);
  const { data, error } = await query;
  if (error) return { titles: [], error: error.message };
  return { titles: (data ?? []).map((row: { title: string }) => row.title), error: null };
}

/** Postgres unique_violation: here, the per-workspace title index. */
export const UNIQUE_VIOLATION = "23505";

/** Tries before giving up when concurrent creates keep taking the chosen title. */
const CREATE_ATTEMPTS = 3;

/**
 * Creates a document in `workspaceId` authored by `userId`, under a title
 * made unique within that workspace. Titles are unique per workspace in the
 * database, so a teammate creating the same title at the same moment makes
 * the insert fail; the titles are then re-read and the next free one taken.
 *
 * `markdown` is given the final title, since a new note's body usually
 * starts with it.
 */
export async function insertWorkspaceDocument(
  admin: SupabaseClient,
  params: {
    userId: string;
    workspaceId: string;
    title: string;
    markdown: (title: string) => string;
    extra?: Record<string, unknown>;
  },
): Promise<{ id: string; title: string } | { error: string }> {
  const { userId, workspaceId, markdown, extra } = params;
  let lastError = "Could not save the note";

  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const { titles, error: titlesError } = await workspaceTitles(admin, workspaceId);
    if (titlesError) return { error: titlesError };

    const title = uniqueTitle(params.title, titles);
    const { data, error } = await admin
      .from("documents")
      .insert({ ...extra, user_id: userId, workspace_id: workspaceId, title, markdown: markdown(title) })
      .select("id")
      .single();
    if (!error && data) return { id: data.id as string, title };

    lastError = error?.message ?? lastError;
    if (error?.code !== UNIQUE_VIOLATION) break;
  }
  return { error: lastError };
}
