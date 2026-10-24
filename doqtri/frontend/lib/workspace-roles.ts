/**
 * Workspace roles (WP-1.1), shared by the browser, the server routes and the
 * relay's checks. Pure: no client, no imports.
 */

export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner";

const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/** Same order as public.workspace_role_rank(). */
export function roleAtLeast(role: WorkspaceRole | null | undefined, min: WorkspaceRole): boolean {
  return role != null && RANK[role] >= RANK[min];
}
