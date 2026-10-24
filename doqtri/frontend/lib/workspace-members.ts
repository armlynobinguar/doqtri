/**
 * What the members screen shows and allows (WP-1.5). Pure, so its rules are
 * tested next to the database's: the RPCs in
 * 20261024150500_workspace_members_management.sql and the relay's
 * authorizeRegistryWrite() (relay-validation.ts) have the last word, and the
 * screen only hides what they would refuse.
 */
import { roleAtLeast, type WorkspaceRole } from "@/lib/workspace-roles";
import {
  allowedChainRole,
  chainRoleOf,
  grantCall,
  revocationCall,
  type ChainWorkspace,
} from "@/lib/stellar/workspace-chain";
import { isReservedEmail } from "@/lib/wallet-address";

export type RosterMember = {
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
  /** Email, or a wallet account's address. */
  label: string | null;
  /** The wallet they sign with on this network, if any. */
  address: string | null;
};

export type ChainJobRow = {
  id: string;
  kind: "revoke" | "reassign_owner";
  userId: string | null;
  address: string | null;
  status: "pending" | "done" | "needs_product_owner" | "failed";
  lastError: string | null;
  attempts: number;
  createdAt: string;
};

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
  admin: "Admin",
  owner: "Owner",
};

export const ROLE_HELP: Record<Exclude<WorkspaceRole, "owner">, string> = {
  viewer: "Reads the workspace's notes",
  editor: "Edits and anchors notes with their own wallet",
  admin: "Also invites and manages members",
};

/** The roles an invite or a role change can give: never owner, which moves by transfer. */
export function assignableRoles(actor: WorkspaceRole | null): Exclude<WorkspaceRole, "owner">[] {
  return roleAtLeast(actor, "admin") ? ["viewer", "editor", "admin"] : [];
}

export function canInvite(actor: WorkspaceRole | null): boolean {
  return roleAtLeast(actor, "admin");
}

/** Owners change anyone else; admins anyone but the owner; nobody their own owner row. */
export function canChangeRole(actor: WorkspaceRole | null, target: RosterMember): boolean {
  return roleAtLeast(actor, "admin") && target.role !== "owner";
}

/** Admins remove anyone but the owner; anyone but the owner may leave. */
export function canRemove(actor: WorkspaceRole | null, target: RosterMember, actorId: string): boolean {
  if (target.role === "owner") return false;
  return target.userId === actorId || roleAtLeast(actor, "admin");
}

/** Only the owner hands a workspace on, and never a personal one (D-30, D-37). */
export function canTransfer(actor: WorkspaceRole | null, personal: boolean): boolean {
  return actor === "owner" && !personal;
}

/** Members the owner could hand the workspace to. */
export function transferCandidates(roster: RosterMember[], actorId: string): RosterMember[] {
  return roster.filter((m) => m.userId !== actorId && m.role !== "owner");
}

export type ParsedInvite = { ok: true; value: string } | { ok: false; error: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WALLET = /^[GC][A-Z2-7]{55}$/;

/**
 * What the invite box accepts: an email address, a Stellar account (G...) or
 * a passkey wallet (C...). doqtri has no usernames. Emails only while the
 * database has email invites switched on (`email_invites_enabled()`, D-49),
 * which needs Supabase's "Confirm email" on; the database refuses them
 * otherwise too.
 */
export function parseInviteIdentifier(input: string, { email = true }: { email?: boolean } = {}): ParsedInvite {
  const value = input.trim();
  if (!value) return { ok: false, error: email ? "Enter an email address or a wallet address." : "Enter a wallet address." };
  if (WALLET.test(value.toUpperCase()) && !value.includes("@")) return { ok: true, value: value.toUpperCase() };
  if (EMAIL.test(value)) {
    if (isReservedEmail(value)) return { ok: false, error: "Invite a wallet account by its wallet address." };
    if (!email) return { ok: false, error: "Invites by email are off for now. Invite them by their wallet address." };
    return { ok: true, value };
  }
  return {
    ok: false,
    error: email ? "That isn't an email address or a Stellar wallet address." : "That isn't a Stellar wallet address.",
  };
}

/** Who signs an on-chain grant: `add_editor` an admin or the owner, `add_admin` the owner. */
export function canSignGrant(fn: "add_editor" | "add_admin", actor: WorkspaceRole | null): boolean {
  return fn === "add_admin" ? actor === "owner" : roleAtLeast(actor, "admin");
}

/**
 * Where one member stands on-chain, for the chip beside their name. Only a
 * team workspace's members hold on-chain roles: in a personal workspace the
 * owner alone signs (D-44), and its notes stay on the owner-only calls.
 */
export type MemberChainState =
  /** REGISTRY_EDITORS off, or a personal workspace: nothing to show. */
  | { kind: "off" }
  /** Still reading the chain. */
  | { kind: "loading" }
  | { kind: "unreachable" }
  /** The workspace isn't on-chain yet; its owner creates it there first. */
  | { kind: "workspace_not_on_chain" }
  /** No wallet: viewers never need one, and nobody can grant one a role. */
  | { kind: "no_wallet"; needed: boolean }
  | { kind: "in_sync" }
  /** The chain still grants more than the database (D-16). */
  | { kind: "removal_pending"; job: ChainJobRow | null }
  /** The chain lacks a role the database gives; someone must sign it. */
  | { kind: "grant"; fn: "add_editor" | "add_admin" }
  /** The database's owner is not the chain's owner. */
  | { kind: "owner_mismatch" };

export function memberChainState(
  member: RosterMember,
  chain: ChainWorkspace | null | undefined | "unreachable",
  jobs: ChainJobRow[],
  { editors, personal }: { editors: boolean; personal: boolean },
): MemberChainState {
  if (!editors || personal) return { kind: "off" };
  const allowed = allowedChainRole(member.role);
  if (!member.address) return { kind: "no_wallet", needed: allowed !== null };
  const job = jobs.find((j) => j.kind === "revoke" && j.address === member.address && j.status !== "done") ?? null;
  if (chain === undefined) return job ? { kind: "removal_pending", job } : { kind: "loading" };
  if (chain === "unreachable") return job ? { kind: "removal_pending", job } : { kind: "unreachable" };
  if (chain === null) return { kind: "workspace_not_on_chain" };

  const current = chainRoleOf(chain, member.address);
  if (member.role === "owner") return current === "owner" ? { kind: "in_sync" } : { kind: "owner_mismatch" };
  if (revocationCall(current, allowed)) return { kind: "removal_pending", job };
  const grant = grantCall(current, allowed);
  return grant ? { kind: "grant", fn: grant } : { kind: "in_sync" };
}

/**
 * Removals still on their way to the chain for people no longer in the
 * roster (they left or were removed), newest first.
 */
export function pendingRemovals(jobs: ChainJobRow[], roster: RosterMember[]): ChainJobRow[] {
  const listed = new Set(roster.map((m) => m.address).filter(Boolean));
  return jobs
    .filter((j) => j.kind === "revoke" && j.status !== "done" && j.address && !listed.has(j.address))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A D-31 handover the product owner has to sign, if one is waiting. */
export function handoverNeedingProductOwner(jobs: ChainJobRow[]): ChainJobRow | null {
  return jobs.find((j) => j.kind === "reassign_owner" && j.status === "needs_product_owner") ?? null;
}

/** A URL-safe slug for a new team workspace: its name, plus a short random tail so it is free. */
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
