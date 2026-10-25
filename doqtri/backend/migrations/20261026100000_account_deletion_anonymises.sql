-- Deleting an account anonymises it and keeps the content (WP-1.11, D-63).
--
-- Until now an account could not be deleted while it had anything that must
-- outlive it: a note anchored on Stellar in its personal workspace, a note
-- someone else wrote there (D-39), a note linked to a qdit project, or a
-- community template it published or bought (D-51's refusals,
-- 20261024150500_workspace_members_management.sql). D-63 replaces those
-- refusals: "Deleting an account anonymises it and keeps the content:
-- anchored notes and marketplace templates or purchases stay, with the
-- wallet as the on-chain identity." Confluence and Jira do the same: a
-- deleted user's pages and issues stay, credited to "Former user".
--
-- What goes with the account (personal data):
--
--   auth.users          the email, the profile metadata (display name,
--                       avatar) and, through Supabase Auth's own foreign
--                       keys, its sessions, refresh tokens and identities
--   wallet_accounts,    the link from a wallet to the account (D-51); the
--   smart_wallets,      wallet itself stays on the ledger
--   wallet_passkeys
--   integration_        the qdit connection and its tokens (cascade, as in
--   connections         20261025100000); the grant on qdit's side is the
--                       user's to revoke there (contract section 2)
--   workspace_invites   to and from the account (D-50, unchanged)
--   doc_locks, chain_usage, ai_usage, mindmap_styles, promo_submissions,
--   referrals, market_reports, workspace_transfers, failed or pending
--   imports (ingests without a note): cascade, as before
--
-- What stays (content), with no reference to the account left:
--
--   documents           every note, in every workspace. Team notes already
--                       stayed (user_id set null, D-56). Notes in the
--                       account's personal workspace now stay too, anchored
--                       or not: the database cannot see a note anchored
--                       straight from Freighter (no chain_writes row), so
--                       "keep the anchored ones" would lose some of them,
--                       and a deletion cannot be undone where keeping can
--   the personal        kept whenever it holds a note or another member, and
--   workspace           renamed "Former user" (its name came from the email,
--                       20261024120000's ensure_personal_workspace). Its
--                       created_by becomes null, the account's owner row
--                       goes, and nobody can become its owner afterwards
--                       (workspace_members_keep_owner: only the creator may
--                       own a personal workspace). Its other members keep
--                       their roles and their access. An empty one, with no
--                       note and nobody else in it, is deleted as before
--   ingests of a note   the import history of a kept note (D-42): the row is
--                       detached from the account (user_id null), so the
--                       note route can still purge the archived original if
--                       the note is deleted later
--   market_templates    stay listed as they were (the Atlassian-like option:
--                       content stays, the author shows as "Former user").
--                       creator_id becomes null; creator_wallet stays, as
--                       the on-chain identity the TemplateMarket contract
--                       pays and credits
--   market_purchases    stay valid: buyer_id becomes null, buyer_wallet and
--                       the on-chain purchase stay, so the creator's
--                       earnings and royalties still count the sale
--   doc_project_links,  qdit links stay with their note (linked_by, user_id
--   node_links          set null, as before); a linked note is no longer
--                       deleted, so documents_refuse_qdit_linked_delete is
--                       not reached
--   chain_writes,       no account in them: the public audit page (/d/[docId])
--   workspace_member_   keeps showing the signing wallet by address, as it
--   removals            always did (it names no one)
--
-- The app shows "Former user" wherever an account would be named and the
-- account is gone (lib/former-user.ts): the template gallery, and the
-- members screen of a kept personal workspace.
--
-- Unchanged: the last owner of a team workspace hands it to the
-- longest-standing admin, with the on-chain admin_reassign_owner queued, and
-- is refused when there is no admin (D-31). Revocations are queued for every
-- editor and admin role the account's wallets hold, before they cascade.

-- ---------------------------------------------------------------------------
-- Marketplace rows keep their wallet, not their account
-- ---------------------------------------------------------------------------

alter table public.market_templates alter column creator_id drop not null;
alter table public.market_templates
  drop constraint market_templates_creator_id_fkey,
  add constraint market_templates_creator_id_fkey
    foreign key (creator_id) references auth.users (id) on delete set null;

alter table public.market_purchases alter column buyer_id drop not null;
alter table public.market_purchases
  drop constraint market_purchases_buyer_id_fkey,
  add constraint market_purchases_buyer_id_fkey
    foreign key (buyer_id) references auth.users (id) on delete set null;

comment on column public.market_templates.creator_id is
  'The account that published the template; null once that account is deleted (D-63). creator_wallet stays.';
comment on column public.market_purchases.buyer_id is
  'The account that bought or claimed the template; null once that account is deleted (D-63). buyer_wallet stays.';


-- ---------------------------------------------------------------------------
-- A kept note keeps its import history
-- ---------------------------------------------------------------------------

-- The foreign key stays `on delete cascade`: an import that never became a
-- note is the uploader's alone and goes with them. The deletion trigger
-- detaches the rest first (below), which needs the column nullable.
alter table public.ingests alter column user_id drop not null;

comment on column public.ingests.user_id is
  'Who uploaded the file; null once that account is deleted and the import belongs to a kept note (D-63).';


-- ---------------------------------------------------------------------------
-- A personal workspace may outlive its owner
-- ---------------------------------------------------------------------------

-- As in 20261024120000, with one exemption: the owner row of a personal
-- workspace whose creator's account is being deleted (the cascade from
-- auth.users, so the account is already gone). handle_deleted_user_workspaces
-- below keeps such a workspace only when it holds notes or other members,
-- and then it has no owner on purpose: nobody else may own a personal
-- workspace (D-30), so its notes stay with nobody in charge, as a deleted
-- Confluence user's personal space does. Every other rule is unchanged.
create or replace function public.workspace_members_keep_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (new.workspace_id <> old.workspace_id or new.user_id <> old.user_id)
  then
    raise exception 'a workspace membership cannot move to another workspace or user'
      using errcode = 'check_violation';
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.role = 'owner' and exists (
    select 1 from public.workspaces w
     where w.id = new.workspace_id and w.is_personal
       and w.created_by is distinct from new.user_id
  ) then
    raise exception 'only the creator of a personal workspace can be its owner'
      using errcode = 'check_violation',
            hint = 'Make them an admin instead, or create a team workspace.';
  end if;

  if tg_op = 'INSERT' or old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then
    return null;
  end if;
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return null;
  end if;

  -- The creator's account is gone (D-63): its personal workspace was kept
  -- without an owner. created_by may already be null, depending on which
  -- cascade ran first.
  if tg_op = 'DELETE'
     and not exists (select 1 from auth.users u where u.id = old.user_id)
     and exists (
       select 1 from public.workspaces w
        where w.id = old.workspace_id and w.is_personal
          and (w.created_by is null or w.created_by = old.user_id)
     )
  then
    return null;
  end if;

  if exists (
    select 1 from public.workspaces w
     where w.id = old.workspace_id and w.is_personal and w.created_by = old.user_id
  ) then
    raise exception 'the owner of a personal workspace cannot leave it or be demoted'
      using errcode = 'check_violation';
  end if;

  perform 1 from public.workspaces w where w.id = old.workspace_id for update;
  if not exists (
    select 1 from public.workspace_members m
     where m.workspace_id = old.workspace_id and m.role = 'owner'
  ) then
    raise exception 'a workspace must keep at least one owner'
      using errcode = 'check_violation',
            hint = 'Make another member an owner first.';
  end if;
  return null;
end;
$$;


-- ---------------------------------------------------------------------------
-- Deleting an account (D-31, D-50, D-63)
-- ---------------------------------------------------------------------------
--
-- 20261024150500's version, with D-51's refusals dropped (anchored personal
-- notes, community templates and purchases) and D-39's too (other people's
-- notes in the personal workspace): nothing is deleted any more that those
-- refusals protected. In their place:
--
-- * The personal workspace is kept, renamed "Former user", when it holds a
--   note or has another member; otherwise it is deleted, as before. Its
--   notes are not touched. The account's owner row leaves with the cascade
--   (workspace_members_keep_owner lets it).
-- * Imports that became notes are detached from the account (user_id null)
--   so they stay with their notes; the rest cascade.
--
-- Unchanged, in the same order: revocations are queued while the wallets
-- are still on record, the invites to and from the account are deleted
-- (D-50), and each team workspace it was the last owner of passes to the
-- longest-standing admin with an on-chain handover queued, or the deletion
-- is refused when there is no admin (D-31).
--
-- The account's role in its own personal workspace is not logged in
-- workspace_member_removals (handle_deleted_user_member_removals skips it,
-- unchanged): it is the owner there, and the registry has no way to revoke
-- a note's owner, so no revocation could ever close the row.
create or replace function public.handle_deleted_user_workspaces()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws       record;
  v_admin    uuid;
  v_personal uuid;
begin
  perform public.enqueue_chain_revocation(m.workspace_id, old.id)
     from public.workspace_members m
    where m.user_id = old.id and m.role in ('editor', 'admin');

  delete from public.workspace_invites i
   where i.invitee = any (public.invite_identifiers_of(old.id))
      or i.invited_by = old.id;

  update public.ingests i
     set user_id = null
   where i.user_id = old.id and i.document_id is not null;

  select w.id into v_personal
    from public.workspaces w
   where w.is_personal and w.created_by = old.id
     for update;
  if v_personal is not null then
    if exists (select 1 from public.documents d where d.workspace_id = v_personal)
       or exists (
         select 1 from public.workspace_members m
          where m.workspace_id = v_personal and m.user_id <> old.id
       )
    then
      update public.workspaces w
         set name = 'Former user'
       where w.id = v_personal;
    else
      delete from public.workspaces w where w.id = v_personal;
    end if;
  end if;

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

revoke execute on function public.workspace_members_keep_owner() from public, anon, authenticated;
revoke execute on function public.handle_deleted_user_workspaces() from public, anon, authenticated;
