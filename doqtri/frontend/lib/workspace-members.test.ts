import { describe, expect, it } from "vitest";
import {
  assignableRoles,
  canChangeRole,
  canInvite,
  canRemove,
  canSignGrant,
  canTransfer,
  handoverNeedingProductOwner,
  memberChainState,
  parseInviteIdentifier,
  pendingRemovals,
  transferCandidates,
  workspaceSlug,
  type ChainJobRow,
  type RosterMember,
} from "@/lib/workspace-members";
import type { WorkspaceRole } from "@/lib/workspace-roles";

const G = "G" + "A".repeat(55);
const C = (c: string) => "C" + c.repeat(55);

function member(role: WorkspaceRole, userId: string = role, address: string | null = C(role[0].toUpperCase())): RosterMember {
  return { userId, role, joinedAt: "2026-10-01T00:00:00Z", label: `${userId}@example.com`, address };
}

function job(over: Partial<ChainJobRow>): ChainJobRow {
  return { id: "j", kind: "revoke", userId: null, address: C("E"), status: "pending", lastError: null, attempts: 1, createdAt: "2026-10-24T00:00:00Z", ...over };
}

const owner = member("owner");
const admin = member("admin");
const editor = member("editor");
const viewer = member("viewer");

describe("who may do what", () => {
  it("lets admins and owners invite, never as owner", () => {
    expect(canInvite("admin")).toBe(true);
    expect(canInvite("editor")).toBe(false);
    expect(assignableRoles("owner")).toEqual(["viewer", "editor", "admin"]);
    expect(assignableRoles("viewer")).toEqual([]);
  });

  it("never lets anyone change the owner's role: it moves by transfer", () => {
    expect(canChangeRole("owner", owner)).toBe(false);
    expect(canChangeRole("admin", editor)).toBe(true);
    expect(canChangeRole("admin", admin)).toBe(true);
    expect(canChangeRole("editor", viewer)).toBe(false);
  });

  it("lets anyone but the owner leave, and admins remove anyone but the owner", () => {
    expect(canRemove("viewer", viewer, "viewer")).toBe(true);
    expect(canRemove("owner", owner, "owner")).toBe(false);
    expect(canRemove("editor", viewer, "editor")).toBe(false);
    expect(canRemove("admin", editor, "admin")).toBe(true);
    expect(canRemove("admin", owner, "admin")).toBe(false);
  });

  it("only offers a transfer to the owner of a team workspace (D-30, D-37)", () => {
    expect(canTransfer("owner", false)).toBe(true);
    expect(canTransfer("owner", true)).toBe(false);
    expect(canTransfer("admin", false)).toBe(false);
    expect(transferCandidates([owner, admin, viewer], "owner").map((m) => m.userId)).toEqual(["admin", "viewer"]);
  });

  it("matches the contract on who signs a grant: add_editor an admin, add_admin the owner", () => {
    expect(canSignGrant("add_editor", "admin")).toBe(true);
    expect(canSignGrant("add_editor", "editor")).toBe(false);
    expect(canSignGrant("add_admin", "admin")).toBe(false);
    expect(canSignGrant("add_admin", "owner")).toBe(true);
  });
});

describe("parseInviteIdentifier", () => {
  it("accepts emails and both kinds of wallet", () => {
    expect(parseInviteIdentifier("  ada@example.com ")).toEqual({ ok: true, value: "ada@example.com" });
    expect(parseInviteIdentifier(G.toLowerCase())).toEqual({ ok: true, value: G });
    expect(parseInviteIdentifier(C("Q"))).toEqual({ ok: true, value: C("Q") });
  });

  it("refuses usernames, blanks and wallet accounts' synthetic emails", () => {
    expect(parseInviteIdentifier("ada").ok).toBe(false);
    expect(parseInviteIdentifier("").ok).toBe(false);
    expect(parseInviteIdentifier(`${G.toLowerCase()}@stellar.doqtri.local`)).toEqual({
      ok: false,
      error: "Invite a wallet account by its wallet address.",
    });
  });
});

describe("memberChainState", () => {
  const team = { editors: true, personal: false };
  const chain = { owner: owner.address!, members: { [admin.address!]: "admin" as const, [editor.address!]: "editor" as const } };

  it("shows nothing with REGISTRY_EDITORS off, or in a personal workspace (D-44)", () => {
    expect(memberChainState(editor, chain, [], { editors: false, personal: false })).toEqual({ kind: "off" });
    expect(memberChainState(editor, chain, [], { editors: true, personal: true })).toEqual({ kind: "off" });
  });

  it("is in sync when the chain grants exactly the database's roles", () => {
    for (const m of [owner, admin, editor]) expect(memberChainState(m, chain, [], team)).toEqual({ kind: "in_sync" });
    expect(memberChainState({ ...viewer }, chain, [], team)).toEqual({ kind: "in_sync" });
  });

  it("asks for add_editor after a promotion, and add_admin for a new admin", () => {
    expect(memberChainState({ ...viewer, role: "editor" }, chain, [], team)).toEqual({ kind: "grant", fn: "add_editor" });
    expect(memberChainState({ ...editor, role: "admin" }, chain, [], team)).toEqual({ kind: "grant", fn: "add_admin" });
  });

  it("shows a demotion as removal pending on-chain until the revoker lands it (D-16)", () => {
    const pending = job({ address: admin.address });
    expect(memberChainState({ ...admin, role: "editor" }, chain, [pending], team)).toEqual({ kind: "removal_pending", job: pending });
    expect(memberChainState({ ...editor, role: "viewer" }, chain, [], team)).toEqual({ kind: "removal_pending", job: null });
  });

  it("shows a pending removal even before the chain has been read", () => {
    const pending = job({ address: editor.address });
    expect(memberChainState(editor, undefined, [pending], team)).toEqual({ kind: "removal_pending", job: pending });
    expect(memberChainState(editor, undefined, [], team)).toEqual({ kind: "loading" });
    expect(memberChainState(editor, "unreachable", [], team)).toEqual({ kind: "unreachable" });
  });

  it("flags an owner the chain does not know, a workspace not on-chain and a member without a wallet", () => {
    expect(memberChainState(owner, { owner: G, members: {} }, [], team)).toEqual({ kind: "owner_mismatch" });
    expect(memberChainState(editor, null, [], team)).toEqual({ kind: "workspace_not_on_chain" });
    expect(memberChainState(member("editor", "e2", null), chain, [], team)).toEqual({ kind: "no_wallet", needed: true });
    expect(memberChainState(member("viewer", "v2", null), chain, [], team)).toEqual({ kind: "no_wallet", needed: false });
  });
});

describe("pending removals and handovers", () => {
  it("lists removals of people no longer in the roster, newest first", () => {
    const gone = job({ id: "a", address: C("X"), createdAt: "2026-10-23T00:00:00Z" });
    const later = job({ id: "b", address: C("Y"), createdAt: "2026-10-24T00:00:00Z" });
    const stillHere = job({ id: "c", address: editor.address });
    const done = job({ id: "d", address: C("Z"), status: "done" });
    expect(pendingRemovals([gone, later, stillHere, done], [owner, editor]).map((j) => j.id)).toEqual(["b", "a"]);
  });

  it("finds a D-31 handover waiting for the product owner", () => {
    const handover = job({ kind: "reassign_owner", address: null, status: "needs_product_owner" });
    expect(handoverNeedingProductOwner([job({}), handover])).toBe(handover);
    expect(handoverNeedingProductOwner([job({ kind: "reassign_owner", status: "pending" })])).toBeNull();
  });
});

describe("workspaceSlug", () => {
  it("matches the database's slug format", () => {
    const slug = workspaceSlug("  Acme Research & Dev! ", () => 0.5);
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(slug.startsWith("acme-research-dev-")).toBe(true);
    expect(workspaceSlug("¡¡¡", () => 0)).toBe("workspace-00000");
    expect(workspaceSlug("x".repeat(80)).length).toBeLessThanOrEqual(64);
  });
});
