import { describe, expect, it } from "vitest";
import {
  applyRosterChange,
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
  recentRemovals,
  transferCandidates,
  type ChainJobRow,
  type RosterChange,
  type RosterMember,
} from "@/lib/workspace-members";
import type { WorkspaceRole } from "@/lib/workspace-roles";

const G = "G" + "A".repeat(55);
const C = (c: string) => "C" + c.repeat(55);

function member(role: WorkspaceRole, userId: string = role, address: string | null = C(role[0].toUpperCase())): RosterMember {
  return { userId, role, joinedAt: "2026-10-01T00:00:00Z", label: `${userId}@example.com`, address };
}

function job(over: Partial<ChainJobRow>): ChainJobRow {
  return { id: "j", kind: "revoke", userId: null, address: C("E"), status: "pending", lastError: null, attempts: 1, createdAt: "2026-10-24T00:00:00Z", txHash: null, doneAt: null, ...over };
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

describe("parseInviteIdentifier with email invites off (D-49)", () => {
  it("still takes wallets", () => {
    expect(parseInviteIdentifier(G, { email: false })).toEqual({ ok: true, value: G });
    expect(parseInviteIdentifier(C("Q"), { email: false })).toEqual({ ok: true, value: C("Q") });
  });

  it("refuses emails, saying why", () => {
    expect(parseInviteIdentifier("ada@example.com", { email: false })).toEqual({
      ok: false,
      error: "Invites by email are off for now. Invite them by their wallet address.",
    });
    expect(parseInviteIdentifier("ada", { email: false })).toEqual({ ok: false, error: "That isn't a Stellar wallet address." });
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

  it("lists removals that reached the chain in the last day, newest first, with their transaction", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const done = (id: string, doneAt: string, over: Partial<ChainJobRow> = {}) =>
      job({ id, address: C(id.toUpperCase()), status: "done", txHash: "a".repeat(64), doneAt, ...over });
    const recent = done("a", "2026-10-30T03:39:41Z");
    const newer = done("b", "2026-10-30T11:00:00Z");
    const old = done("c", "2026-10-29T11:59:00Z");
    const noHash = done("d", "2026-10-30T10:00:00Z", { txHash: null });
    const stillHere = done("e", "2026-10-30T10:00:00Z", { address: editor.address });
    const pending = job({ id: "f", address: C("F") });
    expect(recentRemovals([recent, newer, old, noHash, stillHere, pending], [owner, editor], now).map((j) => j.id)).toEqual(["b", "a"]);
  });

  it("finds a D-31 handover waiting for the product owner", () => {
    const handover = job({ kind: "reassign_owner", address: null, status: "needs_product_owner" });
    expect(handoverNeedingProductOwner([job({}), handover])).toBe(handover);
    expect(handoverNeedingProductOwner([job({ kind: "reassign_owner", status: "pending" })])).toBeNull();
  });
});

// The reducer only: React's useOptimistic does the rollback itself, by
// dropping a settled change and showing the server data again. These pin down
// what that relies on: a change applies to the shown lists, never alters the
// data it is applied to, and can be re-applied safely. The rollback on screen
// is covered end to end in e2e/workspaces.spec.ts.
describe("applying changes before their RPC answers (DOQ-33)", () => {
  const lists = () => ({
    roster: [owner, editor, viewer],
    invites: [{ id: "i1" }, { id: "i2" }],
    myInvites: [{ id: "m1" }],
    emailInvites: true,
  });
  // What useOptimistic shows: every change still waiting, applied over the
  // latest server data.
  const shown = (base: ReturnType<typeof lists>, pending: RosterChange[]) => pending.reduce(applyRosterChange, base);
  const roles = (s: { roster: RosterMember[] }) => s.roster.map((m) => `${m.userId}:${m.role}`);

  it("applies a role change to the shown roster and leaves the data it started from as it was", () => {
    const base = lists();
    const before = structuredClone(base);
    const change: RosterChange = { kind: "role", userId: "viewer", role: "editor" };
    expect(roles(shown(base, [change]))).toEqual(["owner:owner", "editor:editor", "viewer:editor"]);
    expect(shown(base, [])).toEqual(before);
    expect(base).toEqual(before);
  });

  it("changes nothing more when a role change is applied again, or over a reload that has it", () => {
    const change: RosterChange = { kind: "role", userId: "viewer", role: "admin" };
    const kept = applyRosterChange(lists(), change);
    expect(roles(kept)).toEqual(["owner:owner", "editor:editor", "viewer:admin"]);
    expect(shown(kept, [change])).toEqual(kept);
  });

  it("drops a removed member from the shown roster and leaves the data it started from as it was", () => {
    const base = lists();
    const before = structuredClone(base);
    const change: RosterChange = { kind: "remove", userId: "editor" };
    expect(roles(shown(base, [change]))).toEqual(["owner:owner", "viewer:viewer"]);
    expect(shown(base, [])).toEqual(before);
    expect(base).toEqual(before);
  });

  it("changes nothing more when a removal is applied again, and still applies over a newer reload", () => {
    const change: RosterChange = { kind: "remove", userId: "editor" };
    const kept = applyRosterChange(lists(), change);
    expect(shown(kept, [change])).toEqual(kept);
    const reloaded = { ...lists(), roster: [owner, editor, viewer, member("admin", "new")] };
    expect(roles(shown(reloaded, [change]))).toEqual(["owner:owner", "viewer:viewer", "new:admin"]);
  });

  it("drops a withdrawn or declined invite from either list and leaves the lists it started from as they were", () => {
    const base = lists();
    expect(shown(base, [{ kind: "cancel-invite", inviteId: "i2" }]).invites).toEqual([{ id: "i1" }]);
    expect(shown(base, [{ kind: "cancel-invite", inviteId: "m1" }]).myInvites).toEqual([]);
    expect(shown(base, [])).toEqual(lists());
  });

  it("leaves everything else alone", () => {
    const base = lists();
    const next = applyRosterChange(base, { kind: "role", userId: "viewer", role: "editor" });
    expect(next.emailInvites).toBe(true);
    expect(next.invites).toBe(base.invites);
    expect(next.roster[0]).toBe(owner);
    expect(applyRosterChange(base, { kind: "remove", userId: "nobody" }).roster).toEqual(base.roster);
  });
});
