/**
 * A workspace as the registry holds it, and how it should compare with the
 * database (WP-1.5). Pure: shared by the members screen, which reads the
 * chain to show who still needs an on-chain grant, and the server's revoker,
 * which brings removed members down.
 *
 * The registry keeps one owner per workspace and a member list of editors
 * and admins (contract/src/lib.rs). Viewers never hold an on-chain role
 * (D-14), so the database's roles map onto the chain as:
 *
 *   owner   the workspace's on-chain owner
 *   admin   Role::Admin
 *   editor  Role::Editor
 *   viewer  no role
 */
import type { WorkspaceRole } from "@/lib/workspace-roles";

export type ChainMemberRole = "admin" | "editor";
/** A wallet's role in a workspace on-chain; null when it has none. */
export type ChainRole = "owner" | ChainMemberRole | null;

export type ChainWorkspace = { owner: string; members: Record<string, ChainMemberRole> };

function roleOf(value: unknown): ChainMemberRole | null {
  const tag =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value[0]
        : (value as { tag?: unknown } | null)?.tag;
  return tag === "Admin" ? "admin" : tag === "Editor" ? "editor" : null;
}

/**
 * `get_workspace`'s value as the generated client returns it. The SDK hands
 * a contract map back as a Map, a list of pairs or a plain object depending
 * on version and path, and an enum as `{ tag }` or `[tag]`; all are read.
 */
export function parseChainWorkspace(raw: unknown): ChainWorkspace {
  const value = raw as { owner?: unknown; members?: unknown } | null;
  if (value?.owner == null) throw new Error("get_workspace returned no owner");
  const entries: [unknown, unknown][] =
    value.members instanceof Map
      ? [...value.members.entries()]
      : Array.isArray(value.members)
        ? (value.members as [unknown, unknown][])
        : value.members && typeof value.members === "object"
          ? Object.entries(value.members)
          : [];
  const members: Record<string, ChainMemberRole> = {};
  for (const [address, role] of entries) {
    const parsed = roleOf(role);
    if (parsed) members[String(address)] = parsed;
  }
  return { owner: String(value.owner), members };
}

/** `address`'s role in `workspace` on-chain. */
export function chainRoleOf(workspace: ChainWorkspace, address: string): ChainRole {
  if (workspace.owner === address) return "owner";
  return workspace.members[address] ?? null;
}

/**
 * The most the chain should grant a member the database holds as `role`:
 * what a revocation brings them down to. The owner is the chain's owner,
 * which only a transfer changes, so it is never revoked here.
 */
export function allowedChainRole(role: WorkspaceRole | null | undefined): ChainRole {
  switch (role) {
    case "owner":
      return "owner";
    case "admin":
      return "admin";
    case "editor":
      return "editor";
    default:
      return null;
  }
}

const RANK: Record<Exclude<ChainRole, null>, number> = { editor: 1, admin: 2, owner: 3 };
const rank = (role: ChainRole) => (role ? RANK[role] : 0);

/**
 * The call that lowers `current` toward `allowed`, or null when the chain
 * already grants no more than the database: `remove_admin` takes an admin
 * out altogether (re-adding them as an editor is a grant an admin signs),
 * `remove_editor` an editor. "owner" when the chain's owner is above what
 * the database allows, which no revocation can change.
 */
export function revocationCall(current: ChainRole, allowed: ChainRole): "remove_admin" | "remove_editor" | "owner" | null {
  if (rank(current) <= rank(allowed)) return null;
  if (current === "owner") return "owner";
  return current === "admin" ? "remove_admin" : "remove_editor";
}

/**
 * The grant that raises `current` to `allowed`, signed by a workspace
 * admin (`add_editor`) or its owner (`add_admin`), or null when nothing is
 * missing. The owner role is never granted: it moves by transfer.
 */
export function grantCall(current: ChainRole, allowed: ChainRole): "add_editor" | "add_admin" | null {
  if (rank(current) >= rank(allowed)) return null;
  if (allowed === "admin") return "add_admin";
  if (allowed === "editor") return current === null ? "add_editor" : null;
  return null;
}
