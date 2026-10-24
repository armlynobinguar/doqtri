"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRightLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  Loader2Icon,
  LogOutIcon,
  MailPlusIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UserMinusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusTag } from "@/components/ui/status-tag";
import { useWallet } from "@/components/vault/wallet-provider";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { DoqtriRegistry } from "@/lib/stellar/contract-client";
import { REGISTRY_EDITORS } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { NEW_OWNER_APPROVAL_LEDGERS, OWNER_APPROVAL_LEDGERS } from "@/lib/stellar/transfer-approval";
import type { ChainWorkspace } from "@/lib/stellar/workspace-chain";
import { shortenAddress } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import type { WorkspaceRole } from "@/lib/workspace-roles";
import { workspaceSlug } from "@/lib/workspace-scope";
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
  ROLE_HELP,
  ROLE_LABELS,
  transferCandidates,
  type ChainJobRow,
  type MemberChainState,
  type RosterMember,
} from "@/lib/workspace-members";

/** A workspace the user belongs to, for the picker. */
export type WorkspaceChoice = { id: string; name: string; personal: boolean; role: WorkspaceRole };

type Invite = { id: string; label: string | null; role: WorkspaceRole; createdAt: string };
type MyInvite = { id: string; workspaceId: string; workspaceName: string; role: WorkspaceRole; invitedBy: string | null };
type Transfer = {
  fromUser: string;
  toUser: string;
  ownerAddress: string | null;
  newOwnerAddress: string | null;
  ownerApproval: string | null;
};
type FollowUp = { fn: "add_admin"; workspaceId: string; subject: string };

type Loaded = {
  roster: RosterMember[];
  invites: Invite[];
  myInvites: MyInvite[];
  transfer: Transfer | null;
  jobs: ChainJobRow[];
  /** Whether invites by email are switched on (D-49); off until "Confirm email" is. */
  emailInvites: boolean;
};

const EMPTY: Loaded = { roster: [], invites: [], myInvites: [], transfer: null, jobs: [], emailInvites: false };

/** Who someone is, for a list row: their email, or a shortened wallet. */
function nameOf(label: string | null, address?: string | null): string {
  if (label && /^[GC][A-Z2-7]{55}$/.test(label)) return shortenAddress(label);
  return label ?? (address ? shortenAddress(address) : "Someone");
}

async function loadAll(workspaceId: string): Promise<Loaded> {
  const supabase = createSupabaseBrowserClient();
  const [roster, invites, mine, transfer, jobs, emailInvites] = await Promise.all([
    supabase.rpc("workspace_roster", { p_workspace_id: workspaceId, p_network: NETWORK }),
    supabase.rpc("workspace_pending_invites", { p_workspace_id: workspaceId }),
    supabase.rpc("my_workspace_invites"),
    supabase
      .from("workspace_transfers")
      .select("from_user, to_user, owner_address, new_owner_address, owner_approval")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    supabase
      .from("workspace_chain_jobs")
      .select("id, kind, user_id, address, status, last_error, attempts, created_at")
      .eq("workspace_id", workspaceId)
      .in("status", ["pending", "needs_product_owner", "failed"])
      .order("created_at", { ascending: false }),
    supabase.rpc("email_invites_enabled"),
  ]);
  const failed = [roster, invites, mine, transfer, jobs, emailInvites].find((r) => r.error);
  if (failed?.error) throw new Error(failed.error.message);

  type Row = Record<string, unknown>;
  return {
    roster: ((roster.data ?? []) as Row[]).map((r) => ({
      userId: r.user_id as string,
      role: r.role as WorkspaceRole,
      joinedAt: r.joined_at as string,
      label: (r.label as string | null) ?? null,
      address: (r.address as string | null) ?? null,
    })),
    invites: ((invites.data ?? []) as Row[]).map((r) => ({
      id: r.id as string,
      label: (r.label as string | null) ?? null,
      role: r.role as WorkspaceRole,
      createdAt: r.created_at as string,
    })),
    myInvites: ((mine.data ?? []) as Row[]).map((r) => ({
      id: r.id as string,
      workspaceId: r.workspace_id as string,
      workspaceName: r.workspace_name as string,
      role: r.role as WorkspaceRole,
      invitedBy: (r.invited_by as string | null) ?? null,
    })),
    transfer: transfer.data
      ? {
          fromUser: transfer.data.from_user as string,
          toUser: transfer.data.to_user as string,
          ownerAddress: (transfer.data.owner_address as string | null) ?? null,
          newOwnerAddress: (transfer.data.new_owner_address as string | null) ?? null,
          ownerApproval: (transfer.data.owner_approval as string | null) ?? null,
        }
      : null,
    jobs: ((jobs.data ?? []) as Row[]).map((r) => ({
      id: r.id as string,
      kind: r.kind as ChainJobRow["kind"],
      userId: (r.user_id as string | null) ?? null,
      address: (r.address as string | null) ?? null,
      status: r.status as ChainJobRow["status"],
      lastError: (r.last_error as string | null) ?? null,
      attempts: Number(r.attempts ?? 0),
      createdAt: r.created_at as string,
    })),
    emailInvites: emailInvites.data === true,
  };
}

function ledgerNotReady(chain: undefined | "unreachable"): string {
  return chain === undefined ? "Still reading the ledger. Try again in a moment." : "The ledger couldn't be reached. Try again.";
}

/** Asks the server to work the workspace's on-chain follow-ups now (D-16). */
async function syncChain(workspaceId: string): Promise<void> {
  if (!REGISTRY_EDITORS) return;
  await fetch(`/api/workspaces/${workspaceId}/chain-sync`, { method: "POST" }).catch(() => undefined);
}

export function MembersView({
  userId,
  workspaces,
  workspaceId,
}: {
  userId: string;
  workspaces: WorkspaceChoice[];
  workspaceId: string;
}) {
  const router = useRouter();
  const { identity } = useWallet();
  const myAddress = identity.kind === "wallet" ? identity.address : (identity.smartWallet?.address ?? null);
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const personal = workspace?.personal ?? true;

  const [data, setData] = useState<Loaded>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainWorkspace | null | undefined | "unreachable">(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteInput, setInviteInput] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<WorkspaceRole, "owner">>("editor");
  const [transferTo, setTransferTo] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [followUp, setFollowUp] = useState<FollowUp | null>(null);

  const chainShown = REGISTRY_EDITORS && !personal;

  const reload = useCallback(async () => {
    try {
      setData(await loadAll(workspaceId));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Members couldn't be loaded.");
    } finally {
      setLoaded(true);
    }
    if (chainShown) {
      setChain(await DoqtriRegistry.readWorkspace(workspaceId).catch(() => "unreachable" as const));
    }
  }, [workspaceId, chainShown]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 0);
    return () => clearTimeout(timer);
  }, [reload]);

  const me = data.roster.find((m) => m.userId === userId) ?? null;
  const myRole: WorkspaceRole | null = me?.role ?? workspace?.role ?? null;
  const roles = assignableRoles(myRole);
  const removals = useMemo(() => pendingRemovals(data.jobs, data.roster), [data.jobs, data.roster]);
  const handover = handoverNeedingProductOwner(data.jobs);
  const candidates = transferCandidates(data.roster, userId);
  const labelOf = (id: string) => nameOf(data.roster.find((m) => m.userId === id)?.label ?? null);

  async function act(name: string, task: () => Promise<void>, done?: string) {
    setBusy(name);
    try {
      await task();
      if (done) toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${name} failed`);
    } finally {
      setBusy(null);
    }
  }

  async function rpc(fn: string, args: Record<string, unknown>) {
    const { data: result, error } = await createSupabaseBrowserClient().rpc(fn, args);
    if (error) throw new Error(error.message);
    return result as unknown;
  }

  function needWallet(): string {
    if (!myAddress) throw new Error("Set up your wallet first (Profile, wallet & settings).");
    return myAddress;
  }

  const invite = () =>
    act(
      "invite",
      async () => {
        const parsed = parseInviteIdentifier(inviteInput, { email: data.emailInvites });
        if (!parsed.ok) throw new Error(parsed.error);
        await rpc("invite_workspace_member", { p_workspace_id: workspaceId, p_identifier: parsed.value, p_role: inviteRole });
        setInviteInput("");
        await reload();
      },
      data.emailInvites
        ? "Invite sent. Whoever signs in with that email or wallet sees it and joins once they accept it."
        : "Invite sent. Whoever signs in with that wallet sees it and joins once they accept it.",
    );

  const changeRole = (member: RosterMember, role: WorkspaceRole) =>
    act(`role:${member.userId}`, async () => {
      await rpc("set_workspace_member_role", { p_workspace_id: workspaceId, p_user_id: member.userId, p_role: role });
      toast.success(`${nameOf(member.label, member.address)} is now ${ROLE_LABELS[role].toLowerCase()}.`);
      await syncChain(workspaceId);
      await reload();
    });

  const remove = (member: RosterMember) =>
    act(member.userId === userId ? "leave" : `remove:${member.userId}`, async () => {
      await rpc("remove_workspace_member", { p_workspace_id: workspaceId, p_user_id: member.userId });
      await syncChain(workspaceId);
      if (member.userId === userId) {
        toast.success(`You left ${workspace?.name ?? "the workspace"}.`);
        router.push("/vault/workspace/members");
        router.refresh();
        return;
      }
      toast.success(`${nameOf(member.label, member.address)} was removed.`);
      await reload();
    });

  const grant = (member: RosterMember, fn: "add_editor" | "add_admin") =>
    act(`grant:${member.userId}`, async () => {
      const source = needWallet();
      if (!member.address) throw new Error("They need a wallet first.");
      if (fn === "add_editor") await DoqtriRegistry.addEditor(source, workspaceId, member.address);
      else await DoqtriRegistry.addAdmin(source, workspaceId, member.address);
      toast.success("Their on-chain role is in place.");
      await reload();
    });

  const createOnChain = () =>
    act(
      "create-on-chain",
      async () => {
        await DoqtriRegistry.createWorkspace(needWallet(), workspaceId);
        await reload();
      },
      "This workspace is on-chain. Grant your members their roles next.",
    );

  const proposeTransfer = () =>
    act(
      "propose",
      async () => {
        const target = data.roster.find((m) => m.userId === transferTo);
        if (!target) throw new Error("Choose the member to hand the workspace to.");
        let chainArgs: Record<string, string | null> = { p_owner_address: null, p_new_owner_address: null, p_owner_approval: null };
        if (chainShown) {
          if (chain === undefined || chain === "unreachable") throw new Error(ledgerNotReady(chain));
          if (chain) {
            const source = needWallet();
            if (chain.owner !== source) throw new Error("Your wallet isn't this workspace's owner on-chain.");
            if (!target.address) throw new Error("They need a wallet before they can own this workspace on-chain.");
            const approval = await DoqtriRegistry.signTransferApproval(source, workspaceId, source, target.address, OWNER_APPROVAL_LEDGERS);
            chainArgs = { p_owner_address: source, p_new_owner_address: target.address, p_owner_approval: approval };
          }
        }
        await rpc("propose_workspace_transfer", { p_workspace_id: workspaceId, p_to_user: target.userId, ...chainArgs });
        setTransferTo("");
        await reload();
      },
      "Transfer proposed. It completes when they accept.",
    );

  const cancelTransfer = () =>
    act("cancel-transfer", async () => {
      await rpc("cancel_workspace_transfer", { p_workspace_id: workspaceId });
      await reload();
    }, "Transfer called off.");

  const acceptTransfer = () =>
    act("accept-transfer", async () => {
      const transfer = data.transfer;
      if (!transfer) return;
      let approval: string | undefined;
      if (chainShown && transfer.ownerApproval && transfer.ownerAddress) {
        if (chain === undefined || chain === "unreachable") throw new Error(ledgerNotReady(chain));
        const source = needWallet();
        if (chain && chain.owner !== source) {
          approval = await DoqtriRegistry.signTransferApproval(
            source,
            workspaceId,
            transfer.ownerAddress,
            source,
            NEW_OWNER_APPROVAL_LEDGERS,
          );
        }
      }
      const res = await fetch(`/api/workspaces/${workspaceId}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approval }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; followUp?: FollowUp | null };
      if (!res.ok || !body.ok) throw new Error(body.error || "The transfer couldn't be completed.");
      toast.success(`You own ${workspace?.name ?? "the workspace"} now.`);
      setFollowUp(body.followUp ?? null);
      router.refresh();
      await reload();
    });

  const signFollowUp = () =>
    act("follow-up", async () => {
      if (!followUp) return;
      await DoqtriRegistry.addAdmin(needWallet(), followUp.workspaceId, followUp.subject);
      setFollowUp(null);
      await reload();
    }, "The former owner is an admin on-chain again.");

  const acceptInvite = (inv: MyInvite) =>
    act(`accept:${inv.id}`, async () => {
      const joined = (await rpc("accept_workspace_invite", { p_invite_id: inv.id })) as string;
      toast.success(`You joined ${inv.workspaceName}.`);
      router.push(`/vault/workspace/members?ws=${joined}`);
      router.refresh();
    });

  const cancelInvite = (id: string, mine: boolean) =>
    act(`cancel:${id}`, async () => {
      await rpc("cancel_workspace_invite", { p_invite_id: id });
      await reload();
    }, mine ? "Invite declined." : "Invite withdrawn.");

  const createTeam = () =>
    act("create-team", async () => {
      const name = newName.trim();
      if (!name) throw new Error("Give the workspace a name.");
      const row = (await rpc("create_workspace", { p_name: name, p_slug: workspaceSlug(name) })) as { id: string };
      setNewName("");
      toast.success(`${name} is ready. Invite your team.`);
      router.push(`/vault/workspace/members?ws=${row.id}`);
      router.refresh();
    });

  const transfer = data.transfer;
  const transferToMe = transfer?.toUser === userId;

  return (
    <div className="h-full overflow-y-auto" data-testid="members-page">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-8 sm:py-8">
        <section className="glass flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl px-4 py-4 sm:px-5">
          <span aria-hidden className="bg-primary/15 grid size-12 shrink-0 place-items-center rounded-full">
            <UsersIcon className="size-5" strokeWidth={1.5} />
          </span>
          <div className="min-w-[12rem] flex-1">
            <p className="text-muted-foreground text-[12px]">Workspace members</p>
            <h1 className="truncate text-lg font-semibold">{workspace?.name ?? "Workspace"}</h1>
            <p className="text-muted-foreground text-[12px]">
              {personal ? "Personal workspace" : "Team workspace"} · you are {myRole ? ROLE_LABELS[myRole].toLowerCase() : "…"} ·{" "}
              {data.roster.length === 1 ? "1 member" : `${data.roster.length} members`}
            </p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Select
              value={workspaceId}
              onValueChange={(next) => next && router.push(`/vault/workspace/members?ws=${next}`)}
              items={Object.fromEntries(workspaces.map((w) => [w.id, w.personal ? `${w.name} (personal)` : w.name]))}
            >
              <SelectTrigger aria-label="Workspace" size="sm" className="w-full sm:w-56" data-testid="members-workspace">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.personal ? `${w.name} (personal)` : w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Refresh" disabled={busy !== null} onClick={() => void reload()}>
              <RefreshCwIcon />
            </Button>
          </div>
        </section>

        {!REGISTRY_EDITORS ? (
          <Note>
            On-chain roles are off on this registry. Invites, role changes and removals apply in doqtri right away; no
            chain calls are made until the registry is upgraded.
          </Note>
        ) : personal ? (
          <Note>
            In your personal workspace only you sign on-chain. Members can read and edit its notes in doqtri, and it
            stays yours: it can&apos;t be transferred.
          </Note>
        ) : null}

        {handover ? (
          <Note tone="warning" testId="members-handover">
            This workspace passed to {labelOf(handover.userId ?? "")} when its last owner deleted their account. Moving
            it on-chain needs the product owner (the contract admin); until then the former owner&apos;s wallet still owns it
            there.
          </Note>
        ) : null}

        {followUp ? (
          <Note tone="warning" testId="members-follow-up">
            <span className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                The former owner stays an admin here, but a transfer leaves them with no role on-chain. Sign to make them
                an admin there too.
              </span>
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => void signFollowUp()}>
                {busy === "follow-up" ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
                Sign add_admin
              </Button>
            </span>
          </Note>
        ) : null}

        {data.myInvites.length > 0 ? (
          <Section title="Invites for you" icon={MailPlusIcon}>
            <ul className="divide-border -my-1 divide-y text-[13px]" data-testid="my-invites">
              {data.myInvites.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{inv.workspaceName}</span>
                    <span className="text-muted-foreground"> as {ROLE_LABELS[inv.role].toLowerCase()}</span>
                    {inv.invitedBy ? <span className="text-muted-foreground block text-[12px]">from {nameOf(inv.invitedBy)}</span> : null}
                  </span>
                  <Button type="button" size="sm" disabled={busy !== null} onClick={() => void acceptInvite(inv)}>
                    <CheckIcon />
                    Join
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void cancelInvite(inv.id, true)}>
                    Decline
                  </Button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {loadError ? <Note tone="warning">{loadError}</Note> : null}

        {chainShown && chain === null && myRole === "owner" ? (
          <Note>
            <span className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                This workspace isn&apos;t on-chain yet. Put it there so your editors can sign its notes with their own wallets.
              </span>
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => void createOnChain()}>
                {busy === "create-on-chain" ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
                Create on-chain
              </Button>
            </span>
          </Note>
        ) : null}

        <Section title="Members" icon={UsersIcon}>
          {!loaded ? (
            <p className="text-muted-foreground text-[13px]">Loading…</p>
          ) : (
            <ul className="divide-border -my-1 divide-y text-[13px]" data-testid="members-list">
              {data.roster.map((member) => {
                const state = memberChainState(member, chain, data.jobs, { editors: REGISTRY_EDITORS, personal });
                const self = member.userId === userId;
                return (
                  <li key={member.userId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5" data-testid="member-row">
                    <span className="grid min-w-[10rem] flex-1">
                      <span className="truncate" title={member.label ?? member.address ?? undefined}>
                        {nameOf(member.label, member.address)}
                        {self ? <span className="text-muted-foreground"> (you)</span> : null}
                      </span>
                      <span className="text-muted-foreground text-[12px]">
                        Joined {new Date(member.joinedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
                        {member.address ? ` · ${shortenAddress(member.address)}` : ""}
                      </span>
                    </span>
                    <ChainChip state={state} />
                    {state.kind === "grant" && canSignGrant(state.fn, myRole) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void grant(member, state.fn)}
                        data-testid="member-grant"
                      >
                        {busy === `grant:${member.userId}` ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
                        {state.fn === "add_admin" ? "Sign admin role" : "Sign editor role"}
                      </Button>
                    ) : null}
                    {canChangeRole(myRole, member) && !self ? (
                      <Select
                        value={member.role}
                        onValueChange={(next) => next && next !== member.role && void changeRole(member, next as WorkspaceRole)}
                        items={Object.fromEntries(roles.map((r) => [r, ROLE_LABELS[r]]))}
                        disabled={busy !== null}
                      >
                        <SelectTrigger aria-label={`Role of ${nameOf(member.label)}`} size="sm" className="w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {roles.map((r) => (
                            <SelectItem key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-muted-foreground w-28 text-[12px]">{ROLE_LABELS[member.role]}</span>
                    )}
                    {canRemove(myRole, member, userId) ? (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive"
                        aria-label={self ? "Leave this workspace" : `Remove ${nameOf(member.label)}`}
                        disabled={busy !== null}
                        onClick={() => void remove(member)}
                      >
                        {self ? <LogOutIcon /> : <UserMinusIcon />}
                      </Button>
                    ) : (
                      <span className="size-7" aria-hidden />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {removals.length > 0 ? (
            <div className="grid gap-1.5 pt-1" data-testid="pending-removals">
              <p className="text-muted-foreground text-[12px]">Removed here, still being removed on-chain:</p>
              {removals.map((job) => (
                <div key={job.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="font-mono">{job.address ? shortenAddress(job.address) : "—"}</span>
                  <StatusTag tone={job.status === "failed" ? "danger" : "warning"}>
                    {job.status === "failed" ? "Removal failed on-chain" : "Removal pending on-chain"}
                  </StatusTag>
                  {job.lastError ? <span className="text-muted-foreground min-w-0 truncate">{job.lastError}</span> : null}
                </div>
              ))}
              <p className="text-muted-foreground text-[12px]">They can&apos;t sign anything in this workspace meanwhile: doqtri refuses it.</p>
            </div>
          ) : null}
        </Section>

        {canInvite(myRole) ? (
          <Section title="Invite someone" icon={MailPlusIcon}>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void invite();
              }}
            >
              <Input
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
                placeholder={data.emailInvites ? "Email or wallet address (G… or C…)" : "Wallet address (G… or C…)"}
                aria-label={data.emailInvites ? "Email or wallet address" : "Wallet address"}
                className="min-w-[14rem] flex-1"
                data-testid="invite-input"
              />
              <Select
                value={inviteRole}
                onValueChange={(next) => next && setInviteRole(next as Exclude<WorkspaceRole, "owner">)}
                items={Object.fromEntries(roles.map((r) => [r, ROLE_LABELS[r]]))}
              >
                <SelectTrigger aria-label="Role" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" size="sm" disabled={busy !== null || !inviteInput.trim()} data-testid="invite-send">
                {busy === "invite" ? <Loader2Icon className="animate-spin" /> : <MailPlusIcon />}
                Invite
              </Button>
            </form>
            {inviteRole !== "viewer" ? <p className="text-muted-foreground text-[12px]">{ROLE_HELP[inviteRole]}.</p> : null}
            {data.invites.length > 0 ? (
              <ul className="divide-border divide-y text-[13px]" data-testid="pending-invites">
                {data.invites.map((inv) => (
                  <li key={inv.id} className="flex items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 truncate">{nameOf(inv.label)}</span>
                    <StatusTag tone="planned">Invited as {ROLE_LABELS[inv.role].toLowerCase()}</StatusTag>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Withdraw the invite to ${nameOf(inv.label)}`}
                      disabled={busy !== null}
                      onClick={() => void cancelInvite(inv.id, false)}
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        ) : null}

        {transfer && (transferToMe || myRole === "owner" || myRole === "admin") ? (
          <Section title="Ownership transfer" icon={ArrowRightLeftIcon}>
            <p className="text-[13px]" data-testid="transfer-open">
              {transferToMe
                ? `${labelOf(transfer.fromUser)} wants to hand this workspace to you. You'd become its owner, and they'd stay as an admin.`
                : `Waiting for ${labelOf(transfer.toUser)} to accept ownership.`}
              {transfer.ownerApproval && chainShown ? " Accepting signs the transfer on-chain with your wallet." : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {transferToMe ? (
                <Button type="button" size="sm" disabled={busy !== null} onClick={() => void acceptTransfer()} data-testid="transfer-accept">
                  {busy === "accept-transfer" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
                  Accept ownership
                </Button>
              ) : null}
              {transferToMe || myRole === "owner" ? (
                <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void cancelTransfer()}>
                  {transferToMe ? "Decline" : "Call off"}
                </Button>
              ) : null}
            </div>
          </Section>
        ) : canTransfer(myRole, personal) && candidates.length > 0 ? (
          <Section title="Transfer ownership" icon={ArrowRightLeftIcon}>
            <p className="text-muted-foreground text-[13px]">
              Hand this workspace to another member. They become its owner once they accept
              {chainShown ? ", and both your wallets sign the transfer on-chain" : ""}; you stay as an admin.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={transferTo}
                onValueChange={(next) => setTransferTo((next as string) ?? "")}
                items={Object.fromEntries(candidates.map((m) => [m.userId, nameOf(m.label, m.address)]))}
              >
                <SelectTrigger aria-label="New owner" className="min-w-[14rem] flex-1">
                  <SelectValue placeholder="Choose a member" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {nameOf(m.label, m.address)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" size="sm" variant="outline" disabled={busy !== null || !transferTo} onClick={() => void proposeTransfer()}>
                {busy === "propose" ? <Loader2Icon className="animate-spin" /> : <ArrowRightLeftIcon />}
                Propose transfer
              </Button>
            </div>
          </Section>
        ) : null}

        <Section title="New team workspace" icon={PlusIcon}>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void createTeam();
            }}
          >
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Workspace name"
              aria-label="Workspace name"
              maxLength={100}
              className="min-w-[14rem] flex-1"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy !== null || !newName.trim()}>
              {busy === "create-team" ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
              Create
            </Button>
          </form>
        </Section>
      </main>
    </div>
  );
}

/** The on-chain chip beside a member: only when it says something. */
function ChainChip({ state }: { state: MemberChainState }) {
  switch (state.kind) {
    case "removal_pending":
      return (
        <StatusTag tone={state.job?.status === "failed" ? "danger" : "warning"} title={state.job?.lastError ?? undefined} data-testid="chip-removal-pending">
          {state.job?.status === "failed" ? "Removal failed on-chain" : "Removal pending on-chain"}
        </StatusTag>
      );
    case "grant":
      return <StatusTag tone="info">Needs on-chain {state.fn === "add_admin" ? "admin" : "editor"} role</StatusTag>;
    case "owner_mismatch":
      return <StatusTag tone="warning">Not the owner on-chain yet</StatusTag>;
    case "no_wallet":
      return state.needed ? <StatusTag tone="planned">No wallet yet</StatusTag> : null;
    case "in_sync":
      return <StatusTag tone="onchain">On-chain</StatusTag>;
    case "unreachable":
      return <StatusTag tone="planned">Ledger unreachable</StatusTag>;
    default:
      return null;
  }
}

function Note({
  children,
  tone = "info",
  testId,
}: {
  children: React.ReactNode;
  tone?: "info" | "warning";
  testId?: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]",
        tone === "warning" ? "border-warning/40 bg-warning/10" : "border-[var(--glass-lo)] bg-[var(--glass)]",
      )}
    >
      <CircleAlertIcon className={cn("mt-0.5 size-4 shrink-0", tone === "warning" ? "text-warning" : "text-muted-foreground")} strokeWidth={1.5} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  children: React.ReactNode;
}) {
  return (
    <section className="glass grid gap-3 rounded-2xl px-4 py-4 sm:px-5">
      <h2 className="flex items-center gap-2 text-[15px] font-medium">
        <Icon className="text-muted-foreground size-4" strokeWidth={1.5} />
        {title}
      </h2>
      <div className="grid gap-2.5">{children}</div>
    </section>
  );
}
