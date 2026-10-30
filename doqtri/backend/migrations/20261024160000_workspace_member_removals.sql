-- When each workspace member lost the right to sign (WP-1.8).
--
-- The public audit page (/d/[docId]) names the wallet that signed every
-- entry of a note's on-chain history, and flags an entry signed by someone
-- the workspace had already removed. Removal in the app is immediate (D-16),
-- but the chain only follows once the relay's revoke key lands
-- remove_editor, and a member writing from Freighter submits their own
-- transactions, so for a few seconds the registry can still accept their
-- signature (masterplan risk R-05). The ledger has the entry's close time;
-- this table has the other half, which workspace_members cannot give: a
-- removal deletes the membership row and leaves no time behind.
--
-- A row is written whenever a member who could sign stops being able to:
--
--   removed  their membership row is deleted (removed by an admin, left, or
--            their account was deleted)
--   demoted  their role drops below editor, to viewer (D-14: viewers read)
--
-- and closed (`restored_at`) when the same person can sign there again: they
-- are added back, or promoted back to editor or above. An entry is "signed
-- after removal" when its signer has a row with removed_at before the
-- entry's close time and no restored_at before it either.
--
-- The chain matches signers by wallet address, not by account, so each row
-- keeps the addresses the account had when it was removed: its Freighter
-- address (wallet_accounts) and its passkey wallets on every network
-- (smart_wallets). They are copied rather than joined because the account,
-- and with it wallet_accounts, may be deleted later, and the audit trail
-- should not go with it; user_id is kept without a foreign key for the
-- same reason.
--
-- Rows are only ever written by the triggers below, which no client can
-- call. RLS is on with no policies: the service role reads it (the audit
-- page, through signer_removals_for_document) and nobody else. Members of a
-- workspace already see its roster; the table adds nothing they need, and it
-- outlives the membership it describes.
--
-- Account deletion needs its own trigger. Deleting a user cascades to
-- wallet_accounts before it reaches workspace_members (the cascades run in
-- the order their foreign keys were created), so by the time a membership
-- row is deleted the addresses are already gone. on_auth_user_deleted_
-- member_removals runs before the delete, while they are still there, and
-- logs every membership the account can sign in; the row trigger then skips
-- that account's cascaded deletes. The account's own personal workspace is
-- skipped: it is deleted with the account (handle_deleted_user_workspaces).
-- Deleting a workspace logs nothing either: there is nothing left to audit
-- against, and its rows here cascade away with it.

create table public.workspace_member_removals (
  id               bigint generated always as identity primary key,
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  -- No foreign key: the row outlives a deleted account (see above).
  user_id          uuid not null,
  -- The role they held just before losing the right to sign.
  role             public.workspace_role not null check (role <> 'viewer'),
  reason           text not null check (reason in ('removed', 'demoted')),
  wallet_addresses text[] not null default '{}',
  removed_at       timestamptz not null default now(),
  restored_at      timestamptz,
  check (restored_at is null or restored_at >= removed_at)
);

-- The audit page's lookup, and the open-row lookup on restore.
create index workspace_member_removals_workspace_idx
  on public.workspace_member_removals (workspace_id, user_id, removed_at);

alter table public.workspace_member_removals enable row level security;


-- Every wallet address an account signs with: its Freighter account and
-- its passkey wallet on each network. Security definer to read the wallet
-- tables, which are service-role only; never granted to a client.
create function public.member_wallet_addresses(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(a.address order by a.address), '{}')
    from (
      select w.address from public.wallet_accounts w where w.user_id = p_user_id
      union
      select s.address from public.smart_wallets s where s.user_id = p_user_id
    ) a;
$$;

-- Logs a member losing the right to sign, and closes their open rows when
-- they get it back.
--
-- Security definer because the writer (an admin under RLS, or the member
-- leaving) has no rights on this table or the wallet tables.
create function public.log_workspace_member_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_could_sign boolean := tg_op <> 'INSERT'
    and public.workspace_role_rank(old.role) >= public.workspace_role_rank('editor');
  v_can_sign boolean := tg_op <> 'DELETE'
    and public.workspace_role_rank(new.role) >= public.workspace_role_rank('editor');
begin
  if v_could_sign and not v_can_sign then
    -- The workspace itself is being deleted: nothing left to audit.
    if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
      return null;
    end if;
    -- The account is being deleted: on_auth_user_deleted_member_removals
    -- logged this membership while its wallets were still there.
    if tg_op = 'DELETE' and not exists (select 1 from auth.users u where u.id = old.user_id) then
      return null;
    end if;
    insert into public.workspace_member_removals
      (workspace_id, user_id, role, reason, wallet_addresses)
    values (
      old.workspace_id, old.user_id, old.role,
      case when tg_op = 'DELETE' then 'removed' else 'demoted' end,
      public.member_wallet_addresses(old.user_id)
    );
  elsif v_can_sign and not v_could_sign then
    update public.workspace_member_removals r
       set restored_at = now()
     where r.workspace_id = new.workspace_id
       and r.user_id = new.user_id
       and r.restored_at is null;
  end if;
  return null;
end;
$$;

create trigger workspace_members_log_removal
  after insert or update of role or delete on public.workspace_members
  for each row execute function public.log_workspace_member_removal();

-- Logs every signing membership of an account about to be deleted, except
-- in its own personal workspace, which goes with it. Runs before the delete
-- so the account's wallets can still be read (see the header). Should the
-- deletion be refused afterwards (D-31, D-39), these rows roll back with it.
--
-- Security definer because it runs as whichever role deletes the account.
create function public.handle_deleted_user_member_removals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_member_removals
    (workspace_id, user_id, role, reason, wallet_addresses)
  select m.workspace_id, m.user_id, m.role, 'removed', public.member_wallet_addresses(old.id)
    from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id
   where m.user_id = old.id
     and public.workspace_role_rank(m.role) >= public.workspace_role_rank('editor')
     and not (w.is_personal and w.created_by = old.id);
  return old;
end;
$$;

create trigger on_auth_user_deleted_member_removals
  before delete on auth.users
  for each row execute function public.handle_deleted_user_member_removals();

-- The removals the audit page checks a note's signers against: every row of
-- the workspace the note is in, one per wallet address. Service role only:
-- the page reads it server-side and shows nothing but the address and the
-- flag.
create function public.signer_removals_for_document(p_document_id uuid)
returns table (address text, removed_at timestamptz, restored_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.address, r.removed_at, r.restored_at
    from public.documents d
    join public.workspace_member_removals r on r.workspace_id = d.workspace_id
    cross join lateral unnest(r.wallet_addresses) as a(address)
   where d.id = p_document_id
   order by r.removed_at, a.address;
$$;

revoke execute on function public.member_wallet_addresses(uuid) from public, anon, authenticated;
revoke execute on function public.log_workspace_member_removal() from public, anon, authenticated;
revoke execute on function public.handle_deleted_user_member_removals() from public, anon, authenticated;
revoke execute on function public.signer_removals_for_document(uuid) from public, anon, authenticated;
grant execute on function public.signer_removals_for_document(uuid) to service_role;

-- The default privileges grant every new table to the API roles; RLS with
-- no policy already keeps them out, and this says so outright.
revoke all on public.workspace_member_removals from anon, authenticated;
