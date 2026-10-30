-- Managing workspace members, and keeping the chain in step (WP-1.5).
--
-- WP-1.1 let admins and owners write workspace_members directly. That was
-- acceptable while nothing but names lived in a workspace; with documents
-- in them (WP-1.2) and members holding on-chain rights (WP-1.3, WP-1.4) it
-- is not:
--
-- 1. Nobody joins without consent. An admin invites (by wallet address, or
--    by email once email invites are switched on, below) and the invitee
--    accepts; there is no longer any client insert into workspace_members.
--    Admins may invite as viewer, editor or admin, as before, never as owner.
--
-- 2. A team workspace has exactly one owner, as it does on-chain (the
--    registry's Workspace has one `owner`). Ownership moves only by a
--    transfer the new owner accepts (D-29): the owner proposes it, signing
--    the on-chain `transfer_workspace` with their wallet when the chain is
--    on, and the new owner accepts, signing too. The server submits both
--    signatures and only then moves the role in the database, through the
--    service-role function accept_workspace_transfer(). The former owner
--    stays on as an admin; on-chain they hold no role after a transfer, so
--    the app follows with `add_admin` (D-35). A personal workspace is never
--    transferred (D-30, D-37). No client makes anyone an owner any more,
--    through any path.
--
-- 3. Removal is immediate in the database (D-16), and the chain follows.
--    Whenever a member who could hold an on-chain role (editor or admin)
--    leaves, is removed or is demoted, a revocation job is queued in
--    workspace_chain_jobs, in the same transaction, by a trigger, so no
--    path (RPC, direct RLS delete, account deletion, service role) skips it.
--    The server's revoke-only key works the queue (lib/stellar/revoke-editor.ts):
--    it brings the member's on-chain role down to what the database holds at
--    that moment, never further, so a job left over after someone was added
--    back is harmless. Until the job is done the members screen shows the
--    removal as pending on-chain; the relay already refuses the removed
--    member's writes from the database (WP-1.4).
--
-- 4. When the last owner of a team workspace deletes their account, the
--    longest-standing admin becomes owner (D-31, WP-1.1). On-chain that needs
--    `admin_reassign_owner`, which only the contract admin may sign (D-36),
--    so the handover queues a job for it; without the contract admin key the
--    server marks it as needing the product owner.
--
-- Every function that reads auth.users or the wallet tables, or writes on
-- someone else's behalf, is security definer with an empty search_path and
-- checks the caller itself through is_workspace_member(), which only ever
-- asks about auth.uid().


-- ---------------------------------------------------------------------------
-- Direct membership writes
-- ---------------------------------------------------------------------------

-- No client inserts a membership: accept_workspace_invite() does, for the
-- invitee. The bootstrap owner row comes from on_workspace_created (security
-- definer), and the service role bypasses RLS as before.
drop policy "workspace members - insert as admin" on public.workspace_members;

-- Admins and owners still change roles and remove members directly (the
-- RPCs below are the app's path, with clearer errors), but no client ever
-- writes `owner`: ownership is transferred, not granted. An owner's own row
-- stays editable only to demote it, which workspace_members_keep_owner
-- refuses for the only owner.
drop policy "workspace members - update as admin" on public.workspace_members;
create policy "workspace members - update as admin" on public.workspace_members
  for update to authenticated
  using (
    public.is_workspace_member(workspace_id, 'owner')
    or (public.is_workspace_member(workspace_id, 'admin') and role <> 'owner')
  )
  with check (
    role <> 'owner'
    and public.is_workspace_member(workspace_id, 'admin')
  );


-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------

-- An invite is addressed to what the admin typed (`invitee`: a lowercased
-- email, or a wallet address), not to an account: whoever signs in holding
-- that email or wallet sees it and may accept it. Nothing about an invite
-- tells the inviter whether an account behind it exists, or whose: wallet
-- addresses are public on-chain, and before WP-1.5 nothing mapped one to
-- an account's email for anyone but its holder. The inviter sees back only
-- what they typed, and an account's email only once it has joined.
--
-- One open invite per identifier per workspace; inviting again replaces it.
-- Deleting the workspace deletes its invites.
create table public.workspace_invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invitee      text not null check (
                 char_length(invitee) <= 320
                 and (invitee ~ '^[GC][A-Z2-7]{55}$'
                      or (invitee ~ '^[^@\s]+@[^@\s]+$' and invitee = lower(invitee)))
               ),
  role         public.workspace_role not null check (role <> 'owner'),
  invited_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (workspace_id, invitee)
);

create index workspace_invites_invitee_idx on public.workspace_invites (invitee);
create index workspace_invites_invited_by_idx on public.workspace_invites (invited_by, created_at);

alter table public.workspace_invites enable row level security;

-- Email invites are off until Supabase's "Confirm email" is on (D-49).
--
-- An invite can wait for an email nobody has signed up with, so whoever
-- registers that address and signs in with it takes the invite, at its
-- role (admin, even). Only a confirmation mail proves they own the inbox,
-- and the database cannot see the auth setting: with "Confirm email" off
-- (mailer_autoconfirm), Supabase sets email_confirmed_at at signup, so the
-- column alone proves nothing. Until an operator, having turned
-- confirmations on, runs
--
--   update public.invite_settings set email_invites = true;
--
-- invites go only to wallet addresses, which the service role records only
-- after the wallet has signed (backend/README.md, Auth configuration).
-- Turning it off again stops email invites from being sent or delivered;
-- the open ones stay listed for their admins to withdraw.
create table public.invite_settings (
  id            boolean primary key default true check (id),
  email_invites boolean not null default false
);

insert into public.invite_settings (id) values (true);

-- No policies: only the service role and the SQL editor read or write it.
alter table public.invite_settings enable row level security;

create function public.email_invites_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.email_invites from public.invite_settings s), false);
$$;

-- Every identifier an account can be invited by: its email (not a wallet
-- account's synthetic one) once confirmed, its Stellar account and its
-- passkey wallets. This is the account's own list whatever the switch
-- above says: account deletion uses it to drop invites to all of them
-- (D-50). With confirmations on, an email is the account's only once
-- confirmed (D-49); with them off every email counts as confirmed, which
-- is why delivery also needs the switch.
--
-- Internal: clients reach only my_invite_identifiers() below.
create function public.invite_identifiers_of(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(x.identifier), '{}'::text[])
    from (
      select lower(u.email) as identifier
        from auth.users u
       where u.id = p_user_id
         and u.email is not null
         and u.email_confirmed_at is not null
         and lower(u.email) not like '%@stellar.doqtri.local'
      union
      select a.address from public.wallet_accounts a where a.user_id = p_user_id
      union
      select s.address from public.smart_wallets s where s.user_id = p_user_id
    ) x;
$$;

-- The identifiers the caller's invites are delivered to: their wallets,
-- and their confirmed email while email invites are on. Only ever the
-- caller's.
create function public.my_invite_identifiers()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(x.identifier), '{}'::text[])
    from unnest(public.invite_identifiers_of((select auth.uid()))) x (identifier)
   where x.identifier ~ '^[GC]' or public.email_invites_enabled();
$$;

-- The invitee sees the invites addressed to them; admins and owners see
-- their workspace's. Every write goes through the functions below.
create policy "workspace invites - select as invitee or admin" on public.workspace_invites
  for select to authenticated
  using (
    invitee = any (public.my_invite_identifiers())
    or public.is_workspace_member(workspace_id, 'admin')
  );


-- ---------------------------------------------------------------------------
-- Ownership transfers (D-29)
-- ---------------------------------------------------------------------------

-- At most one open transfer per workspace. `owner_approval` is the outgoing
-- owner's signed authorization of exactly `transfer_workspace(workspace,
-- owner_address, new_owner_address)` (a base64 SorobanAuthorizationEntry),
-- present when the workspace is on-chain. It is not a secret: it authorizes
-- that one call, which also needs the new owner's signature, and the server
-- checks it against the call before submitting.
create table public.workspace_transfers (
  workspace_id      uuid primary key references public.workspaces(id) on delete cascade,
  from_user         uuid not null references auth.users(id) on delete cascade,
  to_user           uuid not null references auth.users(id) on delete cascade,
  owner_address     text check (owner_address ~ '^[GC][A-Z2-7]{55}$'),
  new_owner_address text check (new_owner_address ~ '^[GC][A-Z2-7]{55}$'),
  owner_approval    text check (char_length(owner_approval) <= 8192),
  created_at        timestamptz not null default now(),
  check (from_user <> to_user),
  check ((owner_approval is null) = (owner_address is null)
         and (owner_address is null) = (new_owner_address is null))
);

alter table public.workspace_transfers enable row level security;

-- Both parties and the workspace's admins see an open transfer.
create policy "workspace transfers - select as party or admin" on public.workspace_transfers
  for select to authenticated
  using (
    to_user = (select auth.uid())
    or public.is_workspace_member(workspace_id, 'admin')
  );


-- ---------------------------------------------------------------------------
-- On-chain follow-ups
-- ---------------------------------------------------------------------------

-- Work the server owes the chain after a database change.
--
--   revoke          bring `address`'s on-chain role in the workspace down to
--                   what the database holds for its account now (none,
--                   editor or admin). Signed by the revoke-only key.
--   reassign_owner  make `user_id`'s wallet the workspace's on-chain owner
--                   (D-31). Signed by the contract admin (D-36).
--
-- `network` is the passkey wallet's network; null for a Stellar account
-- (G...), which is the same address on every network.
create table public.workspace_chain_jobs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  kind            text not null check (kind in ('revoke', 'reassign_owner')),
  user_id         uuid references auth.users(id) on delete set null,
  address         text check (address ~ '^[GC][A-Z2-7]{55}$'),
  network         text check (network in ('testnet', 'mainnet')),
  status          text not null default 'pending'
                  check (status in ('pending', 'done', 'needs_product_owner', 'failed')),
  attempts        integer not null default 0,
  last_error      text check (char_length(last_error) <= 500),
  tx_hash         text check (tx_hash ~ '^[0-9a-f]{64}$'),
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (kind <> 'revoke' or address is not null)
);

-- One open job per wallet per workspace, so a removal queued twice (the
-- account-deletion trigger and the cascade after it) is one job, and one
-- open handover per workspace, which a later handover re-points to its new
-- heir (handle_deleted_user_workspaces). A handover whose heir's account is
-- gone is left with no user_id; the server fails it rather than guess.
create unique index workspace_chain_jobs_open_idx
  on public.workspace_chain_jobs (workspace_id, kind, coalesce(address, ''), coalesce(network, ''))
  where status in ('pending', 'needs_product_owner');
create index workspace_chain_jobs_due_idx
  on public.workspace_chain_jobs (next_attempt_at) where status = 'pending';

alter table public.workspace_chain_jobs enable row level security;

-- Admins see their workspace's jobs (the members screen's "removal pending
-- on-chain"), and the member a job is about sees it too. Only the service
-- role writes.
create policy "workspace chain jobs - select as admin or subject" on public.workspace_chain_jobs
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_workspace_member(workspace_id, 'admin')
  );

create function public.workspace_chain_jobs_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspace_chain_jobs_before_update
  before update on public.workspace_chain_jobs
  for each row execute function public.workspace_chain_jobs_before_update();

-- Queues a revocation for every wallet `p_user_id` holds: their passkey
-- wallet on each network and their Stellar account. An account with no
-- wallet never held an on-chain role and queues nothing. An open job for
-- the same wallet already covers it.
create function public.enqueue_chain_revocation(p_workspace_id uuid, p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.workspace_chain_jobs (workspace_id, kind, user_id, address, network)
  select p_workspace_id, 'revoke', p_user_id, w.address, w.network
    from (
      select s.address, s.network from public.smart_wallets s where s.user_id = p_user_id
      union all
      select a.address, null::text from public.wallet_accounts a where a.user_id = p_user_id
    ) w
  on conflict do nothing;
$$;

-- After a membership row loses rights (removed, left, demoted):
--
-- * an editor or admin's on-chain revocation is queued. Owners are left
--   out: the owner's role leaves only by a transfer, which moves it
--   on-chain itself, or with the account, which
--   handle_deleted_user_workspaces covers.
-- * someone who is no longer an admin can no longer invite, so the invites
--   they sent and nobody has accepted are withdrawn; otherwise a removed
--   admin's invite could still bring someone in, as an admin.
--
-- Nothing happens when the workspace itself is going (its rows cascade).
create function public.workspace_members_chain_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and public.workspace_role_rank(new.role) >= public.workspace_role_rank(old.role)
  then
    return null;
  end if;
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return null;
  end if;
  if old.role in ('editor', 'admin') then
    perform public.enqueue_chain_revocation(old.workspace_id, old.user_id);
  end if;
  if old.role in ('admin', 'owner')
     and (tg_op = 'DELETE' or public.workspace_role_rank(new.role) < public.workspace_role_rank('admin'))
  then
    delete from public.workspace_invites i
     where i.workspace_id = old.workspace_id and i.invited_by = old.user_id;
  end if;
  return null;
end;
$$;

create trigger workspace_members_chain_sync
  after update or delete on public.workspace_members
  for each row execute function public.workspace_members_chain_sync();


-- ---------------------------------------------------------------------------
-- Who is who
-- ---------------------------------------------------------------------------

-- What an invite is addressed to, from what an admin typed: an email
-- address (trimmed, lowercased), a Stellar account (G...) or a passkey
-- wallet (C...). Wallet accounts sign in with a synthetic address
-- (lib/wallet-auth.ts) that nobody types; their G address is how they are
-- invited. Anything else is refused (22023).
create function public.invite_identifier(p_identifier text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_id text := btrim(coalesce(p_identifier, ''));
begin
  if v_id ~ '^[GC][A-Z2-7]{55}$' then
    return v_id;
  elsif v_id ~ '^[^@\s]+@[^@\s]+$' and char_length(v_id) <= 320
        and lower(v_id) not like '%@stellar.doqtri.local' then
    return lower(v_id);
  end if;
  raise exception 'Enter an email address or a Stellar wallet address.'
    using errcode = '22023';
end;
$$;

-- The account an identifier names, or null. Internal: it maps public
-- wallet addresses to accounts, so no client ever calls it.
create function public.find_account(p_identifier text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id   text := public.invite_identifier(p_identifier);
  v_user uuid;
begin
  if v_id ~ '^G' then
    select a.user_id into v_user from public.wallet_accounts a where a.address = v_id;
  elsif v_id ~ '^C' then
    select s.user_id into v_user from public.smart_wallets s where s.address = v_id limit 1;
  else
    -- Confirmed emails only, as in invite_identifiers_of (D-49).
    select u.id into v_user from auth.users u
     where lower(u.email) = v_id and u.email_confirmed_at is not null
     limit 1;
  end if;
  return v_user;
end;
$$;

-- How the app names an account to its teammates: the email, or for a
-- wallet account its address.
create function public.account_label(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when u.email is null then null
    when lower(u.email) like '%@stellar.doqtri.local' then upper(split_part(u.email, '@', 1))
    else u.email
  end
    from auth.users u
   where u.id = p_user_id;
$$;

-- The wallet that signs for an account on `p_network`: its passkey wallet
-- there, else its Stellar account. Null when it has neither.
create function public.account_chain_address(p_user_id uuid, p_network text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.address from public.smart_wallets s where s.user_id = p_user_id and s.network = p_network),
    (select a.address from public.wallet_accounts a where a.user_id = p_user_id)
  );
$$;

-- The roster of a workspace the caller is a member of, with each member's
-- label and signing wallet: what the members screen lists. Empty for
-- anyone else.
create function public.workspace_roster(p_workspace_id uuid, p_network text)
returns table (user_id uuid, role public.workspace_role, joined_at timestamptz, label text, address text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, m.role, m.joined_at,
         public.account_label(m.user_id),
         public.account_chain_address(m.user_id, p_network)
    from public.workspace_members m
   where m.workspace_id = p_workspace_id
     and public.is_workspace_member(p_workspace_id, 'viewer')
   order by public.workspace_role_rank(m.role) desc, m.joined_at, m.user_id;
$$;

-- Open invites of a workspace, for its admins and owners, each labelled
-- with what the admin typed and nothing about any account behind it.
create function public.workspace_pending_invites(p_workspace_id uuid)
returns table (id uuid, role public.workspace_role, created_at timestamptz, label text)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.role, i.created_at, i.invitee
    from public.workspace_invites i
   where i.workspace_id = p_workspace_id
     and public.is_workspace_member(p_workspace_id, 'admin')
   order by i.created_at;
$$;

-- The caller's own open invites (to any of their identifiers, in
-- workspaces they are not in yet), with the workspace's name (which they
-- cannot read yet) and who invited them.
create function public.my_workspace_invites()
returns table (id uuid, workspace_id uuid, workspace_name text, role public.workspace_role,
               invited_by text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.workspace_id, w.name, i.role, public.account_label(i.invited_by), i.created_at
    from public.workspace_invites i
    join public.workspaces w on w.id = i.workspace_id
   where i.invitee = any (public.my_invite_identifiers())
     and not exists (
       select 1 from public.workspace_members m
        where m.workspace_id = i.workspace_id and m.user_id = (select auth.uid())
     )
   order by i.created_at;
$$;


-- ---------------------------------------------------------------------------
-- Member management
-- ---------------------------------------------------------------------------

-- Invites whoever holds `p_identifier` (an email or a wallet address) into
-- the workspace as `p_role`. Admins and owners only; never as owner.
-- Inviting the same identifier again replaces its open invite.
--
-- It answers the same whether or not an account holds the identifier: the
-- invite waits for whoever signs in with it. The one exception is someone
-- already in the workspace (23505), whom the admin sees on the roster
-- anyway. An inviter has at most 100 invites sent in the last day open at
-- once (54000), so nobody floods strangers with them. An email is refused
-- while email invites are off (invite_settings).
--
-- Errors: 42501 not allowed, 22023 owner, a malformed identifier or an
-- email while email invites are off, 23505 already a member, 54000 too many
-- open invites.
create function public.invite_workspace_member(
  p_workspace_id uuid,
  p_identifier   text,
  p_role         public.workspace_role
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_invitee text;
  v_user    uuid;
  v_invite  uuid;
begin
  if not public.is_workspace_member(p_workspace_id, 'admin') then
    raise exception 'Only an admin of this workspace can invite people.'
      using errcode = '42501';
  end if;
  if p_role is null or p_role = 'owner' then
    raise exception 'Ownership is transferred, not granted. Invite them as an admin.'
      using errcode = '22023';
  end if;

  v_invitee := public.invite_identifier(p_identifier);
  if v_invitee !~ '^[GC]' and not public.email_invites_enabled() then
    raise exception 'Invites by email are off for now. Invite them by their wallet address.'
      using errcode = '22023';
  end if;
  v_user := public.find_account(v_invitee);
  if v_user is not null and exists (
    select 1 from public.workspace_members m
     where m.workspace_id = p_workspace_id and m.user_id = v_user
  ) then
    raise exception 'They are already a member of this workspace.'
      using errcode = '23505';
  end if;
  if (select count(*) from public.workspace_invites i
       where i.invited_by = v_uid
         and i.created_at > now() - interval '1 day'
         and not (i.workspace_id = p_workspace_id and i.invitee = v_invitee)) >= 100
  then
    raise exception 'You have sent too many invites today. Withdraw some, or try again tomorrow.'
      using errcode = '54000';
  end if;

  insert into public.workspace_invites as i (workspace_id, invitee, role, invited_by)
  values (p_workspace_id, v_invitee, p_role, v_uid)
  on conflict (workspace_id, invitee) do update
    set role = excluded.role, invited_by = excluded.invited_by, created_at = now()
  returning i.id into v_invite;
  return v_invite;
end;
$$;

-- The invitee joins with the invite's role, and any other invite of theirs
-- to the same workspace (by another of their identifiers) closes. Returns
-- the workspace id.
create function public.accept_workspace_invite(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids    text[] := public.my_invite_identifiers();
  v_invite public.workspace_invites;
begin
  delete from public.workspace_invites i
   where i.id = p_invite_id and i.invitee = any (v_ids)
  returning * into v_invite;
  if v_invite.id is null then
    raise exception 'That invite is no longer open.'
      using errcode = 'P0002';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_invite.workspace_id, (select auth.uid()), v_invite.role)
  on conflict (workspace_id, user_id) do nothing;
  delete from public.workspace_invites i
   where i.workspace_id = v_invite.workspace_id and i.invitee = any (v_ids);
  return v_invite.workspace_id;
end;
$$;

-- The invitee declines, or an admin of the workspace withdraws the invite.
create function public.cancel_workspace_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.workspace_invites i
   where i.id = p_invite_id
     and (i.invitee = any (public.my_invite_identifiers())
          or public.is_workspace_member(i.workspace_id, 'admin'));
  if not found then
    raise exception 'That invite is no longer open.'
      using errcode = 'P0002';
  end if;
end;
$$;

-- Changes a member's role, by the rules of the update policy: owners change
-- anyone else, admins anyone but an owner, and nobody makes an owner.
-- Lowering an editor or admin queues their on-chain revocation (trigger).
create function public.set_workspace_member_role(
  p_workspace_id uuid,
  p_user_id      uuid,
  p_role         public.workspace_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.workspace_role;
begin
  if not public.is_workspace_member(p_workspace_id, 'admin') then
    raise exception 'Only an admin of this workspace can change roles.'
      using errcode = '42501';
  end if;
  if p_role is null or p_role = 'owner' then
    raise exception 'Ownership is transferred, not granted.'
      using errcode = '22023';
  end if;

  select m.role into v_current
    from public.workspace_members m
   where m.workspace_id = p_workspace_id and m.user_id = p_user_id
     for update;
  if v_current is null then
    raise exception 'They are not a member of this workspace.'
      using errcode = 'P0002';
  end if;
  if v_current = 'owner' then
    raise exception 'The owner''s role changes only by transferring the workspace.'
      using errcode = '42501';
  end if;
  if v_current = p_role then
    return;
  end if;

  update public.workspace_members m
     set role = p_role
   where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
end;
$$;

-- Removes a member at once (D-16): an admin removes anyone but the owner,
-- and anyone may remove themselves (leave). The owner cannot leave
-- (workspace_members_keep_owner); they transfer the workspace first. An
-- editor or admin's on-chain removal is queued by the trigger.
create function public.remove_workspace_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.workspace_role;
  v_self boolean := p_user_id = (select auth.uid());
begin
  if not v_self and not public.is_workspace_member(p_workspace_id, 'admin') then
    raise exception 'Only an admin of this workspace can remove members.'
      using errcode = '42501';
  end if;

  select m.role into v_role
    from public.workspace_members m
   where m.workspace_id = p_workspace_id and m.user_id = p_user_id
     for update;
  if v_role is null then
    raise exception 'They are not a member of this workspace.'
      using errcode = 'P0002';
  end if;
  if v_role = 'owner' and not v_self then
    raise exception 'The owner can''t be removed. They can transfer the workspace instead.'
      using errcode = '42501';
  end if;

  delete from public.workspace_members m
   where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
  -- An open transfer to someone who left is void.
  delete from public.workspace_transfers t
   where t.workspace_id = p_workspace_id and (t.to_user = p_user_id or t.from_user = p_user_id);
end;
$$;


-- ---------------------------------------------------------------------------
-- Ownership transfer
-- ---------------------------------------------------------------------------

-- The owner proposes handing a team workspace to another member. With the
-- chain on, the owner's wallet has signed `transfer_workspace` and the three
-- chain fields carry that signature and both addresses; without it they are
-- null. A new proposal replaces an open one. Never for a personal workspace
-- (D-30, D-37).
create function public.propose_workspace_transfer(
  p_workspace_id      uuid,
  p_to_user           uuid,
  p_owner_address     text default null,
  p_new_owner_address text default null,
  p_owner_approval    text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not public.is_workspace_member(p_workspace_id, 'owner') then
    raise exception 'Only the owner can transfer this workspace.'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.is_personal) then
    raise exception 'A personal workspace stays with the person who created it.'
      using errcode = '22023';
  end if;
  if p_to_user is null or p_to_user = v_uid then
    raise exception 'Choose another member to hand the workspace to.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workspace_members m
     where m.workspace_id = p_workspace_id and m.user_id = p_to_user
  ) then
    raise exception 'The new owner must already be a member of this workspace.'
      using errcode = 'P0002';
  end if;

  insert into public.workspace_transfers as t
    (workspace_id, from_user, to_user, owner_address, new_owner_address, owner_approval)
  values (p_workspace_id, v_uid, p_to_user, p_owner_address, p_new_owner_address, p_owner_approval)
  on conflict (workspace_id) do update
    set from_user = excluded.from_user, to_user = excluded.to_user,
        owner_address = excluded.owner_address,
        new_owner_address = excluded.new_owner_address,
        owner_approval = excluded.owner_approval,
        created_at = now();
end;
$$;

-- Either party calls off an open transfer.
create function public.cancel_workspace_transfer(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.workspace_transfers t
   where t.workspace_id = p_workspace_id
     and (select auth.uid()) in (t.from_user, t.to_user);
  if not found then
    raise exception 'There is no open transfer of this workspace for you.'
      using errcode = 'P0002';
  end if;
end;
$$;

-- The database side of an accepted transfer: `p_user_id` (the new owner,
-- whom the route has verified) becomes the owner and the former owner an
-- admin (D-35 then restores that admin role on-chain). Returns the former
-- owner's id.
--
-- Service role only: with the chain on, the route submits the on-chain
-- transfer first and calls this only once the ledger has it, so the
-- database never names an owner the chain does not (D-04). A client calling
-- it directly could skip that step.
create function public.accept_workspace_transfer(p_workspace_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.workspace_transfers;
begin
  select * into v_transfer
    from public.workspace_transfers t
   where t.workspace_id = p_workspace_id
     for update;
  if v_transfer.workspace_id is null or v_transfer.to_user <> p_user_id then
    raise exception 'There is no open transfer of this workspace to you.'
      using errcode = 'P0002';
  end if;
  if exists (select 1 from public.workspaces w where w.id = p_workspace_id and w.is_personal) then
    raise exception 'A personal workspace stays with the person who created it.'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workspace_members m
     where m.workspace_id = p_workspace_id and m.user_id = v_transfer.from_user and m.role = 'owner'
  ) then
    raise exception 'Whoever proposed this transfer no longer owns the workspace.'
      using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.workspace_members m
     where m.workspace_id = p_workspace_id and m.user_id = p_user_id
  ) then
    raise exception 'You are no longer a member of this workspace.'
      using errcode = 'P0002';
  end if;

  -- Promote first: the workspace keeps an owner at every step.
  update public.workspace_members m set role = 'owner'
   where m.workspace_id = p_workspace_id and m.user_id = p_user_id;
  update public.workspace_members m set role = 'admin'
   where m.workspace_id = p_workspace_id and m.user_id = v_transfer.from_user;
  delete from public.workspace_transfers t where t.workspace_id = p_workspace_id;
  return v_transfer.from_user;
end;
$$;

-- Jobs due for the server, claimed for two minutes so concurrent runs do not
-- send the same call twice (a second send would be harmless: every job is
-- idempotent on-chain). Service role only.
create function public.claim_workspace_chain_jobs(p_workspace_id uuid default null, p_limit integer default 20)
returns setof public.workspace_chain_jobs
language sql
security definer
set search_path = ''
as $$
  update public.workspace_chain_jobs j
     set attempts = j.attempts + 1,
         next_attempt_at = now() + interval '2 minutes'
   where j.id in (
     select c.id from public.workspace_chain_jobs c
      where c.status = 'pending'
        and c.next_attempt_at <= now()
        and (p_workspace_id is null or c.workspace_id = p_workspace_id)
      order by c.created_at
      limit greatest(1, least(coalesce(p_limit, 20), 100))
        for update skip locked
   )
  returning j.*;
$$;


-- ---------------------------------------------------------------------------
-- Deleting an account (D-31, D-39)
-- ---------------------------------------------------------------------------
--
-- WP-1.2's version, with these additions:
--
-- * An account whose personal workspace holds a note anchored through the
--   relay is refused up front (restrict_violation, with a hint), as
--   WP-1.2's check refuses one holding other people's notes. The registry
--   has no delete, so an anchored note is kept with its record, as the
--   note delete route keeps it (app/api/notes/[id]); chain_writes'
--   `on delete restrict` would refuse the deletion anyway, further down
--   and with nothing to say why. Notes anchored straight from a Freighter
--   wallet leave no chain_writes row, so the database cannot see them;
--   the delete-account route has to ask the ledger, as the note route does.
-- * So is an account that has published a community template (a pending
--   draft included) or bought or claimed one: market_templates.creator_id
--   and market_purchases.buyer_id are `on delete restrict`
--   (20261013000000), which would refuse it further down with a bare
--   foreign key error, after nothing had run. This says why instead. A
--   known limit: such accounts cannot be deleted until those rows are
--   anonymised or let go, which is a follow-up.
-- * Before anything cascades, the account's editor and admin roles in every
--   workspace, someone else's personal one included, are queued for
--   revocation, while its wallets are still on record (wallet_accounts
--   cascades with the account, before the memberships do, so the members
--   trigger would find no wallet). A workspace that is not on-chain makes
--   the job a no-op for the revoker.
-- * Open invites addressed to the account's identifiers (its confirmed
--   email, its Stellar account, its passkey wallets) are deleted (D-50).
--   They name an address, not the account, so nothing would cascade them.
--   An unconfirmed email was never the account's, so an invite to it stays
--   for whoever owns the inbox. The invites the account sent are withdrawn
--   too, as for an admin who is removed (workspace_members_chain_sync):
--   `invited_by` is `on delete set null`, and that cascade can run before
--   the membership rows' does, which would leave the members trigger
--   nothing to match, and the invite open at its role.
-- * The passkey wallet is retired (D-51): its revocations are queued here,
--   which is what needs its C address, and only then, once this trigger
--   (and every other BEFORE DELETE trigger on auth.users) has run, does the
--   delete itself cascade to the wallet record and its passkeys (the foreign
--   keys relaxed just below). The ledger keeps the wallet's history, and
--   chain_writes, which does not reference the record, keeps the index of
--   its writes. Most passkey holders have anchored a personal note, though,
--   and are refused by the first point: the wallet is retired only for
--   those who have not.
-- * Each team workspace handed to its longest-standing admin also queues
--   the on-chain `admin_reassign_owner` (D-36) to that admin's wallet. A
--   handover still open from an earlier one (the heir is now deleting their
--   own account before the chain caught up) is re-pointed to the new heir
--   and tried afresh, so the chain ends with the owner the database has.

-- smart_wallets was `on delete restrict` against auth.users (20261008000000),
-- so that deleting an account could not silently erase the record of a
-- wallet that still owned documents on-chain. That made every passkey
-- account undeletable: the delete failed, and with it D-31's handover and
-- the revocations above. What restrict protected is now done first, by the
-- trigger: an account with anchored personal notes is refused, and every
-- role the wallet holds is queued for revocation by its address. Both run
-- BEFORE DELETE, and a foreign key's cascade only after the row is gone, so
-- the order holds for every path that deletes an account (D-51).
alter table public.smart_wallets
  drop constraint smart_wallets_user_id_fkey,
  add constraint smart_wallets_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade;
alter table public.wallet_passkeys
  drop constraint wallet_passkeys_user_id_network_fkey,
  add constraint wallet_passkeys_user_id_network_fkey
    foreign key (user_id, network) references public.smart_wallets (user_id, network) on delete cascade;

create or replace function public.handle_deleted_user_workspaces()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws       record;
  v_admin    uuid;
  v_others   integer;
  v_anchored integer;
  v_listed   integer;
  v_bought   integer;
begin
  select count(*) into v_others
    from public.documents d
    join public.workspaces w on w.id = d.workspace_id
   where w.is_personal and w.created_by = old.id
     and d.user_id is not null and d.user_id <> old.id;
  if v_others > 0 then
    raise exception 'this account''s personal workspace holds % note(s) written by other people',
      v_others
      using errcode = 'restrict_violation',
            hint = 'Delete those notes, or have their authors copy them out, then delete the account.';
  end if;

  select count(distinct d.id) into v_anchored
    from public.documents d
    join public.workspaces w on w.id = d.workspace_id
    join public.chain_writes c on c.document_id = d.id
   where w.is_personal and w.created_by = old.id;
  if v_anchored > 0 then
    raise exception 'this account''s personal workspace holds % note(s) anchored on Stellar',
      v_anchored
      using errcode = 'restrict_violation',
            hint = 'An anchored note is kept with its on-chain record, which cannot be deleted, so the account stays too.';
  end if;

  select count(*) into v_listed from public.market_templates t where t.creator_id = old.id;
  select count(*) into v_bought from public.market_purchases p where p.buyer_id = old.id;
  if v_listed > 0 or v_bought > 0 then
    raise exception 'this account has published % community template(s) and bought or claimed % on record',
      v_listed, v_bought
      using errcode = 'restrict_violation',
            hint = 'Templates and purchases keep their account (market_templates.creator_id, market_purchases.buyer_id), so the account stays too, for now.';
  end if;

  perform public.enqueue_chain_revocation(m.workspace_id, old.id)
     from public.workspace_members m
    where m.user_id = old.id and m.role in ('editor', 'admin');

  delete from public.workspace_invites i
   where i.invitee = any (public.invite_identifiers_of(old.id))
      or i.invited_by = old.id;

  delete from public.documents d
   using public.workspaces w
   where d.workspace_id = w.id and w.is_personal and w.created_by = old.id;

  delete from public.workspaces w
   where w.is_personal and w.created_by = old.id;

  for v_ws in
    select w.id, w.name
      from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id
     where m.user_id = old.id and m.role = 'owner' and not w.is_personal
     order by w.id
       for update of w
  loop
    continue when exists (
      select 1 from public.workspace_members m
       where m.workspace_id = v_ws.id and m.role = 'owner' and m.user_id <> old.id
    );

    perform 1
       from public.workspace_members m
      where m.workspace_id = v_ws.id and m.role = 'admin'
        for update;
    select m.user_id into v_admin
      from public.workspace_members m
     where m.workspace_id = v_ws.id and m.role = 'admin'
     order by m.joined_at, m.user_id
     limit 1;
    if v_admin is null then
      raise exception 'this account is the last owner of workspace "%" (%), which has no admin to take it over',
        v_ws.name, v_ws.id
        using errcode = 'restrict_violation',
              hint = 'Make another member of that workspace an owner or an admin, then delete the account.';
    end if;

    update public.workspace_members m
       set role = 'owner'
     where m.workspace_id = v_ws.id and m.user_id = v_admin;

    update public.workspace_chain_jobs j
       set user_id = v_admin, status = 'pending', attempts = 0,
           last_error = null, next_attempt_at = now()
     where j.workspace_id = v_ws.id and j.kind = 'reassign_owner'
       and j.status in ('pending', 'needs_product_owner');
    if not found then
      insert into public.workspace_chain_jobs (workspace_id, kind, user_id)
      values (v_ws.id, 'reassign_owner', v_admin);
    end if;
  end loop;

  return old;
end;
$$;


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke execute on function public.workspace_chain_jobs_before_update() from public, anon, authenticated;
revoke execute on function public.enqueue_chain_revocation(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.workspace_members_chain_sync() from public, anon, authenticated;
revoke execute on function public.handle_deleted_user_workspaces() from public, anon, authenticated;
revoke execute on function public.find_account(text) from public, anon, authenticated;
revoke execute on function public.invite_identifiers_of(uuid) from public, anon, authenticated;
revoke execute on function public.invite_identifier(text) from public, anon, authenticated;
-- The invites policy evaluates it as the caller; it only ever returns the
-- caller's own identifiers.
revoke execute on function public.my_invite_identifiers() from public, anon;
grant execute on function public.my_invite_identifiers() to authenticated, service_role;
-- The members screen asks it to word the invite box; it says nothing about
-- anyone.
revoke execute on function public.email_invites_enabled() from public, anon;
grant execute on function public.email_invites_enabled() to authenticated, service_role;
revoke execute on function public.account_label(uuid) from public, anon, authenticated;
revoke execute on function public.account_chain_address(uuid, text) from public, anon, authenticated;
grant execute on function public.account_chain_address(uuid, text) to service_role;

revoke execute on function public.accept_workspace_transfer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_workspace_transfer(uuid, uuid) to service_role;
revoke execute on function public.claim_workspace_chain_jobs(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_workspace_chain_jobs(uuid, integer) to service_role;

revoke execute on function public.workspace_roster(uuid, text) from public, anon;
grant execute on function public.workspace_roster(uuid, text) to authenticated, service_role;
revoke execute on function public.workspace_pending_invites(uuid) from public, anon;
grant execute on function public.workspace_pending_invites(uuid) to authenticated, service_role;
revoke execute on function public.my_workspace_invites() from public, anon;
grant execute on function public.my_workspace_invites() to authenticated, service_role;
revoke execute on function public.invite_workspace_member(uuid, text, public.workspace_role) from public, anon;
grant execute on function public.invite_workspace_member(uuid, text, public.workspace_role) to authenticated, service_role;
revoke execute on function public.accept_workspace_invite(uuid) from public, anon;
grant execute on function public.accept_workspace_invite(uuid) to authenticated, service_role;
revoke execute on function public.cancel_workspace_invite(uuid) from public, anon;
grant execute on function public.cancel_workspace_invite(uuid) to authenticated, service_role;
revoke execute on function public.set_workspace_member_role(uuid, uuid, public.workspace_role) from public, anon;
grant execute on function public.set_workspace_member_role(uuid, uuid, public.workspace_role) to authenticated, service_role;
revoke execute on function public.remove_workspace_member(uuid, uuid) from public, anon;
grant execute on function public.remove_workspace_member(uuid, uuid) to authenticated, service_role;
revoke execute on function public.propose_workspace_transfer(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.propose_workspace_transfer(uuid, uuid, text, text, text) to authenticated, service_role;
revoke execute on function public.cancel_workspace_transfer(uuid) from public, anon;
grant execute on function public.cancel_workspace_transfer(uuid) to authenticated, service_role;

-- Clients read these tables only through their select policies; every write
-- goes through the functions above or the service role.
revoke all on public.invite_settings from anon, authenticated;
revoke insert, update, delete, truncate on public.workspace_invites from anon, authenticated;
revoke insert, update, delete, truncate on public.workspace_transfers from anon, authenticated;
revoke insert, update, delete, truncate on public.workspace_chain_jobs from anon, authenticated;
