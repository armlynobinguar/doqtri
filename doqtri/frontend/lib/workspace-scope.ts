/**
 * Which workspace the vault is showing (WP-1.7). The vault shows one
 * workspace at a time: its explorer, quick switcher, graph, mindmaps and
 * [[wikilink]] resolution all read that workspace's notes, and new notes,
 * template copies and imports land in it.
 *
 * The choice is a preference, not a permission: it lives in a cookie, and
 * every read of it is checked against the user's memberships, so a stale or
 * forged value can only ever fall back to the personal workspace. RLS and the
 * routes' role checks still decide what anyone may read or write.
 *
 * Pure: no client, no imports beyond the role order, so the browser, the
 * server and the tests share it.
 */
import { roleAtLeast, type WorkspaceRole } from "@/lib/workspace-roles";

/** One workspace the signed-in user belongs to, as the switcher lists it. */
export type WorkspaceChoice = {
  id: string;
  name: string;
  /** The user's own personal workspace, or a personal one they were added to (D-30). */
  personal: boolean;
  /** The user's role in it. */
  role: WorkspaceRole;
  /** They created it: for a personal workspace, it is theirs. */
  mine: boolean;
};

/** The httpOnly cookie that remembers the active workspace in this browser. */
export const ACTIVE_WORKSPACE_COOKIE = "doqtri_ws";

/** A year: the choice should outlast a session, not a browser. */
export const ACTIVE_WORKSPACE_MAX_AGE_S = 60 * 60 * 24 * 365;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * The cookie's value: the user's id, then the workspace's. Keyed by user so
 * that whoever signs in next on the same browser starts in their own personal
 * workspace instead of inheriting a team the two happen to share.
 */
export function encodeActiveWorkspace(userId: string, workspaceId: string): string {
  return `${userId}.${workspaceId}`;
}

/** The workspace the cookie names for `userId`, or null when it names none or another user's. */
export function parseActiveWorkspace(raw: string | null | undefined, userId: string): string | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const owner = raw.slice(0, dot);
  const workspaceId = raw.slice(dot + 1);
  if (owner !== userId || !isWorkspaceId(workspaceId)) return null;
  return workspaceId;
}

/**
 * The user's own personal workspace first, then every other one by name.
 * Personal workspaces they were added to (D-30) sort with the teams, since
 * those are someone else's.
 */
export function sortWorkspaces(workspaces: WorkspaceChoice[]): WorkspaceChoice[] {
  const own = (w: WorkspaceChoice) => (w.personal && w.mine ? 0 : 1);
  return [...workspaces].sort(
    (a, b) => own(a) - own(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/** The user's own personal workspace in the list, if it is there. */
export function ownPersonalWorkspace(workspaces: WorkspaceChoice[]): WorkspaceChoice | null {
  return workspaces.find((w) => w.personal && w.mine) ?? null;
}

/**
 * The workspace to show: the requested one while the user is still a member
 * of it, otherwise their personal workspace. A user removed from the team
 * they were looking at lands back in their own notes on the next load (D-16).
 * Null only when the list holds neither, which the caller repairs.
 */
export function pickActiveWorkspace(
  workspaces: WorkspaceChoice[],
  requestedId: string | null | undefined,
): WorkspaceChoice | null {
  if (requestedId) {
    const requested = workspaces.find((w) => w.id === requestedId);
    if (requested) return requested;
  }
  return ownPersonalWorkspace(workspaces);
}

/** Editors and above create notes, copy templates and import files into a workspace (D-14). */
export function canCreateIn(workspace: Pick<WorkspaceChoice, "role"> | null | undefined): boolean {
  return roleAtLeast(workspace?.role, "editor");
}

/** How the switcher names a workspace. */
export function workspaceLabel(workspace: Pick<WorkspaceChoice, "name" | "personal" | "mine">): string {
  return workspace.personal && workspace.mine ? `${workspace.name} (personal)` : workspace.name;
}

/** Same bounds as the workspaces.name check. */
export const MAX_WORKSPACE_NAME = 100;

/** The name a new workspace would be created with, or an error to show beside the field. */
export function checkWorkspaceName(raw: string): { name: string } | { error: string } {
  const name = raw.trim();
  if (!name) return { error: "Give the workspace a name." };
  if (name.length > MAX_WORKSPACE_NAME) return { error: `Names are at most ${MAX_WORKSPACE_NAME} characters.` };
  return { name };
}

/**
 * A URL-safe slug for a new team workspace: its name, plus a short random
 * tail so it is free. Fits the workspaces.slug check (<= 64 characters,
 * lowercase words joined by single hyphens).
 */
export function workspaceSlug(name: string, random: () => number = Math.random): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const tail = Math.floor(random() * 36 ** 5)
    .toString(36)
    .padStart(5, "0");
  return `${base || "workspace"}-${tail}`;
}

/**
 * Where to go after switching workspaces from a link: a vault path, or the
 * vault itself. Never another origin or a non-vault page, so the switch
 * route cannot be used as an open redirect.
 */
export function vaultReturnPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/vault") || raw.startsWith("//") || raw.includes("\\")) return "/vault";
  const rest = raw.slice("/vault".length);
  if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("?")) return "/vault";
  return raw;
}

/**
 * Where to land after switching from `pathname`: the vault-wide views
 * (graph, mindmap, templates) stay put and show the new workspace, while a
 * note belongs to the workspace being left, so a note's pages go back to
 * the vault.
 */
export function pathAfterSwitch(pathname: string): string {
  const segment = pathname.split("/")[2] ?? "";
  if (segment === "graph" || segment === "mindmap" || segment === "templates") return `/vault/${segment}`;
  if (segment === "profile" || segment === "earnings" || segment === "workspace") return pathname;
  return "/vault";
}
