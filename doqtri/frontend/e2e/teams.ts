import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { serviceRest } from "./helpers";

export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner";

/**
 * A team workspace owned by `ownerId`, made with the service role. Inserting
 * with created_by fires on_workspace_created, which adds the owner row, the
 * same as the create_workspace() RPC the app calls.
 */
export async function createTeamWorkspace(name: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  const slug = `e2e-${id.slice(0, 8)}`;
  await serviceRest("workspaces", {
    method: "POST",
    body: { id, name, slug, created_by: ownerId, is_personal: false },
    prefer: "return=minimal",
  });
  return id;
}

/** Adds or re-roles a member directly, skipping the invite (the invite flow has its own test). */
export async function setMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  await serviceRest("workspace_members?on_conflict=workspace_id,user_id", {
    method: "POST",
    body: { workspace_id: workspaceId, user_id: userId, role },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

export async function memberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const rows = await serviceRest<{ role: WorkspaceRole }[]>(
    `workspace_members?workspace_id=eq.${workspaceId}&user_id=eq.${userId}&select=role`,
  );
  return rows[0]?.role ?? null;
}

/**
 * Removes a team workspace and everything in it. Documents first: they hold
 * the workspace `on delete restrict`, and a qdit-linked one refuses deletion
 * until its doc_project_links row is gone. Members, invites and chain jobs
 * cascade with the workspace.
 */
export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const docs = await serviceRest<{ id: string }[]>(`documents?workspace_id=eq.${workspaceId}&select=id`);
  if (docs.length > 0) {
    const ids = docs.map((d) => d.id).join(",");
    await serviceRest(`doc_project_links?document_id=in.(${ids})`, { method: "DELETE" });
    await serviceRest(`documents?id=in.(${ids})`, { method: "DELETE" });
  }
  await serviceRest(`workspaces?id=eq.${workspaceId}`, { method: "DELETE" });
}

/** Makes `workspaceId` the active one for whoever `request` is signed in as. */
export async function activateWorkspace(request: APIRequestContext, workspaceId: string): Promise<void> {
  const res = await request.post("/api/workspaces/active", { data: { workspaceId } });
  expect(res.ok(), await res.text()).toBeTruthy();
}
