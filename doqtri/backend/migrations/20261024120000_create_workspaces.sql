-- Workspaces: the team container doqtri's documents will belong to (WP-1.1).
--
-- Today every document belongs to one user (`documents.user_id`) and every
-- policy is `auth.uid() = user_id`. Teams need a level above the user: a
-- workspace, with members holding one of four roles.
--
--   viewer  reads the workspace's documents, never edits or signs (D-14)
--   editor  edits and signs on-chain with their own wallet (D-14, D-15)
--   admin   also manages members, except owners
--   owner   also manages owners; a workspace always keeps at least one
--
-- This migration is the schema only. Documents do not reference a workspace
-- yet: WP-1.2 adds `documents.workspace_id`, points it at the owner's
-- personal workspace created below, and rewrites the `auth.uid() = user_id`
-- policies to go through is_workspace_member(). Until then nothing reads
-- these tables, every existing policy is untouched and no document changes
-- hands.
--
-- Every user gets a personal workspace (`is_personal`), as owner: existing
-- users through the backfill at the bottom of this file, new ones through a
-- trigger on auth.users. That is where WP-1.2 moves each user's documents, so
-- no document is left without a workspace to belong to.
--
-- The browser creates workspaces through create_workspace(), which makes the
-- caller the owner in the same statement, and manages members directly under
-- RLS. The membership checks follow qdit's project_members helpers (qdit
-- supabase/migrations/20260731133313_rls.sql); see is_workspace_member().
--
-- A personal workspace always belongs to the account it was made for. It
-- may take members (D-30), but its creator is its only owner: nobody else
-- can be added as or promoted to owner, and the creator cannot leave, be
-- demoted or be removed, by anyone (workspace_members_keep_owner). WP-1.2
-- moves each user's documents into it on that guarantee.
--
-- Deleting an account deletes its personal workspace with it, and never
-- leaves a team workspace without an owner (D-31): where the account is the
-- last owner, the longest-standing admin becomes owner, and where there is
-- no admin the deletion is refused (on_auth_user_deleted_workspaces).
--
-- Adding a member needs no consent from the person added. Admins and owners
-- may add anyone as viewer, editor or admin, and in a team workspace an owner
-- may then promote them to owner and leave. That is acceptable while
-- nothing but names lives here, but WP-1.5 must replace direct inserts into
-- workspace_members with an invite the invitee accepts before documents
-- arrive in team workspaces; otherwise a user can be made responsible for a
-- workspace they never joined.

create type public.workspace_role as enum ('viewer', 'editor', 'admin', 'owner');

create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 100),
  -- Globally unique so a workspace URL needs no owner segment.
  slug        text not null unique check (
    char_length(slug) <= 64 and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  -- `on delete set null`: deleting an account must not take a team's
  -- workspace (and, after WP-1.2, its documents) with it. Its personal
  -- workspace is deleted first, by on_auth_user_deleted_workspaces.
  created_by  uuid references auth.users(id) on delete set null default auth.uid(),
  -- The one workspace created for each user automatically. Only
  -- ensure_personal_workspace() creates these.
  is_personal boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One personal workspace per user, which also makes the backfill idempotent.
create unique index workspaces_one_personal_idx
  on public.workspaces (created_by) where is_personal;

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         public.workspace_role not null default 'viewer',
  -- When this membership began. Decides who takes over a workspace whose
  -- last owner deletes their account (D-31), so clients never write it:
  -- workspace_members_before_write stamps it and keeps it fixed.
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- "Which workspaces am I in", the lookup every vault load will make.
create index workspace_members_user_idx on public.workspace_members (user_id);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;


-- Role order for >= comparisons: viewer(1) < editor(2) < admin(3) < owner(4).
-- Touches no tables, so it needs no elevated rights.
create function public.workspace_role_rank(p_role public.workspace_role)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'viewer' then 1
    when 'editor' then 2
    when 'admin'  then 3
    when 'owner'  then 4
  end;
$$;

-- True when the calling user holds at least p_min_role in p_workspace_id.
--
-- Security definer because of recursion: the natural policy on
-- workspace_members is "you may read a membership row if you are a member of
-- that workspace", but written inline that policy selects from
-- workspace_members, which re-enters the same policy, and Postgres aborts
-- with "infinite recursion detected in policy". Run as its owner, the inner
-- select is not subject to RLS and the cycle is broken. To keep that safe:
-- the subject is always auth.uid(), never an argument, so it cannot probe
-- another user's membership; it returns a bare boolean, never rows; and
-- search_path is empty with every name schema-qualified.
create function public.is_workspace_member(
  p_workspace_id uuid,
  p_min_role     public.workspace_role default 'viewer'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.workspace_members m
     where m.workspace_id = p_workspace_id
       and m.user_id = (select auth.uid())
       and public.workspace_role_rank(m.role) >= public.workspace_role_rank(p_min_role)
  );
$$;

revoke execute on function public.workspace_role_rank(public.workspace_role) from public, anon;
grant execute on function public.workspace_role_rank(public.workspace_role) to authenticated, service_role;
revoke execute on function public.is_workspace_member(uuid, public.workspace_role) from public, anon;
grant execute on function public.is_workspace_member(uuid, public.workspace_role) to authenticated, service_role;


-- workspaces
--
-- Members read their workspaces, and only while they are members: whoever
-- is removed, the creator included, stops seeing even the name at once
-- (D-16).
--
-- There is no insert policy. Anyone signed in creates a workspace through
-- create_workspace() below, never a personal one; on_workspace_created makes
-- them its owner. Going through a function rather than a direct insert means
-- the row can be returned to its creator without a read clause for
-- non-members. Admins and owners rename it. There is no delete policy:
-- deleting a workspace will delete or orphan its documents once WP-1.2 lands,
-- so it stays with the service role until a package decides what deletion
-- means.

create policy "workspaces - select as member" on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id, 'viewer'));
create policy "workspaces - update as admin" on public.workspaces
  for update to authenticated
  using (public.is_workspace_member(id, 'admin'))
  with check (public.is_workspace_member(id, 'admin'));


-- workspace_members
--
-- Members read the roster of their own workspaces. Owners change and remove
-- anyone. Admins do the same for everyone but owners: they cannot touch an
-- owner's row (the USING clause sees the row as it is) and cannot make anyone
-- an owner (the WITH CHECK clause sees the row as it will be). Admins and
-- owners add members, but never straight in as owner: an owner promotes an
-- existing member instead, so nobody becomes an owner in one step without
-- having been in the workspace (see the header on consent and WP-1.5).
-- Anyone may remove their own row, i.e. leave. Viewers and editors cannot
-- change any row, their own included, so nobody promotes themselves.
--
-- Rules RLS cannot express, because they depend on other rows, are enforced
-- by workspace_members_keep_owner below for every writer, the service role
-- included: the last owner can neither leave nor be demoted, the creator of a
-- personal workspace can neither leave, be demoted nor be removed, nobody
-- else is ever an owner of a personal workspace (D-30), and a row cannot be
-- moved to another workspace or user. joined_at is the server's, not the
-- writer's (workspace_members_before_write): the policies let admins write
-- whole rows, and a backdated joined_at would jump the D-31 succession queue.
--
-- Every clause goes through is_workspace_member() rather than querying
-- workspace_members inline; that is the recursion the helper exists to avoid.

create policy "workspace members - select as member" on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id, 'viewer'));
create policy "workspace members - insert as admin" on public.workspace_members
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id, 'admin') and role <> 'owner');
create policy "workspace members - update as admin" on public.workspace_members
  for update to authenticated
  using (
    public.is_workspace_member(workspace_id, 'owner')
    or (public.is_workspace_member(workspace_id, 'admin') and role <> 'owner')
  )
  with check (
    public.is_workspace_member(workspace_id, 'owner')
    or (public.is_workspace_member(workspace_id, 'admin') and role <> 'owner')
  );
create policy "workspace members - delete as admin or leave" on public.workspace_members
  for delete to authenticated
  using (
    public.is_workspace_member(workspace_id, 'owner')
    or (public.is_workspace_member(workspace_id, 'admin') and role <> 'owner')
    or user_id = (select auth.uid())
  );


-- The creator of a workspace becomes its owner.
--
-- Security definer because the insert policy on workspace_members requires
-- the caller to already be an admin of the workspace, which nobody is for the
-- first row. This trigger is the bootstrap that breaks that cycle.
create function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new.id, new.created_by, 'owner')
    on conflict (workspace_id, user_id) do update set role = 'owner';
  end if;
  return new;
end;
$$;

create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- Stamps updated_at, and keeps who created a workspace, and whether it is
-- someone's personal one, fixed: the update policy lets admins write the
-- whole row, and these are not theirs to change. created_by may become null
-- only once that account is gone from auth.users, which is the
-- `on delete set null` of an account being deleted; nulling it otherwise
-- would detach a personal workspace from its user.
--
-- Security definer only to read auth.users for that check.
create function public.workspaces_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id <> old.id
     or new.is_personal <> old.is_personal
     or new.created_at <> old.created_at
     or (new.created_by is distinct from old.created_by
         and (new.created_by is not null
              or exists (select 1 from auth.users u where u.id = old.created_by)))
  then
    raise exception 'a workspace''s id, created_by, is_personal and created_at cannot change'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspaces_before_update
  before update on public.workspaces
  for each row execute function public.workspaces_before_update();

-- Keeps joined_at true. The longest-standing admin inherits a workspace whose
-- last owner deletes their account (D-31), and the insert and update policies
-- let an admin write every column, so a client-chosen joined_at would let an
-- admin backdate themselves, or put an outsider at the head of the queue,
-- and make an owner by a route admins are otherwise denied.
--
-- A client insert (anon, authenticated) always gets now(), whatever it sends;
-- the service role and the migration role may still give one, to import a
-- roster with its history. Nobody changes it afterwards: someone who leaves
-- and is added back starts again from the day they are added back.
--
-- Not security definer: current_user must be the writer's own role. It reads
-- no tables.
create function public.workspace_members_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if current_user in ('anon', 'authenticated') then
      new.joined_at := now();
    end if;
  elsif new.joined_at is distinct from old.joined_at then
    raise exception 'a workspace membership''s joined_at cannot change'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger workspace_members_before_write
  before insert or update on public.workspace_members
  for each row execute function public.workspace_members_before_write();

-- Keeps every workspace with at least one owner, keeps the creator of a
-- personal workspace as its only owner, and keeps membership rows in place.
--
-- Without the personal rules a co-owner could remove the creator, or the
-- creator could hand ownership over and leave, and the workspace would still
-- be that user's personal one (created_by, is_personal) while someone else
-- controls it; WP-1.2 would then move the creator's documents into it. A
-- second owner is refused outright (D-30) rather than only kept from
-- removing the creator: an owner there could still rename the workspace and
-- manage its members, and after WP-1.2 those are the creator's documents.
--
-- Runs after the statement's row change, so it sees the roster as the change
-- leaves it, and locks the workspace row first so two owners demoting each
-- other at once cannot both succeed. One removal is let through: the
-- workspace itself being deleted (its rows cascade). An account being
-- deleted gets no exemption: on_auth_user_deleted_workspaces has already
-- deleted its personal workspace and handed every team workspace it was the
-- last owner of to an admin (D-31), so the roster the cascade leaves passes
-- these checks, and should anything slip past that, the deletion fails here
-- rather than leave a workspace with no owner.
--
-- Security definer so the check sees every row of the roster and can lock the
-- workspace row whatever the caller's own rights are.
create function public.workspace_members_keep_owner()
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

create trigger workspace_members_keep_owner
  after insert or update or delete on public.workspace_members
  for each row execute function public.workspace_members_keep_owner();


-- Makes p_user_id an owner of p_workspace_id. A no-op, writing nothing, when
-- they already are, so re-running the backfill changes no row. Promoting
-- passes workspace_members_keep_owner, which only guards rows losing owner.
-- Only ensure_personal_workspace() calls it.
create function public.restore_personal_owner(p_workspace_id uuid, p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.workspace_members as m (workspace_id, user_id, role)
  values (p_workspace_id, p_user_id, 'owner')
  on conflict (workspace_id, user_id) do update set role = 'owner'
   where m.role <> 'owner';
$$;

-- The user's personal workspace, created on first call. Returns its id.
--
-- Also makes sure the user is an owner of it, restoring the membership if it
-- is missing or demoted. workspace_members_keep_owner prevents that through
-- any normal write, but this is the repair path, and WP-1.2 moves documents
-- into whatever id it returns, so it must never return a workspace the user
-- does not control.
--
-- Named after the email's local part. Wallet accounts have a synthetic
-- address (`<G-address>@stellar.doqtri.local`, see lib/wallet-auth.ts) and
-- accounts may have no email at all; both are named "Personal". The slug is
-- random rather than derived from the email, so it does not leak the address
-- into URLs.
--
-- Security definer because it reads auth.users and creates a personal
-- workspace, which no client may insert. Execute is granted
-- to the service role only, so the app can heal an account that somehow
-- lacks one.
create function public.ensure_personal_workspace(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_email text;
  v_name  text;
begin
  select w.id into v_id
    from public.workspaces w
   where w.created_by = p_user_id and w.is_personal;
  if v_id is not null then
    perform public.restore_personal_owner(v_id, p_user_id);
    return v_id;
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = p_user_id;
  if v_email is not null and v_email not like '%@stellar.doqtri.local' then
    v_name := nullif(btrim(left(split_part(v_email, '@', 1), 100)), '');
  end if;
  v_name := coalesce(v_name, 'Personal');

  for i in 1..5 loop
    begin
      insert into public.workspaces (name, slug, created_by, is_personal)
      values (
        v_name,
        'personal-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
        p_user_id,
        true
      )
      on conflict (created_by) where is_personal do nothing
      returning id into v_id;

      if v_id is null then
        -- A concurrent call created it first: use theirs.
        select w.id into v_id
          from public.workspaces w
         where w.created_by = p_user_id and w.is_personal;
      end if;
    exception when unique_violation then
      -- Another workspace already has this slug; draw again.
      v_id := null;
    end;
    exit when v_id is not null;
  end loop;

  if v_id is null then
    raise exception 'could not create a personal workspace for %', p_user_id;
  end if;
  -- A fresh workspace already has its owner from on_workspace_created; one a
  -- concurrent call made is checked like any existing one.
  perform public.restore_personal_owner(v_id, p_user_id);
  return v_id;
end;
$$;

-- Creates a team workspace owned by the caller and returns it. This is the
-- browser's only way to create one (`supabase.rpc('create_workspace', ...)`).
--
-- Security definer because there is no insert policy on workspaces. The row
-- is always the caller's and never personal, whatever the client sends;
-- on_workspace_created adds the owner membership within the same statement,
-- so the caller can read the workspace as soon as this returns. The name and
-- slug checks on the table still apply, and a taken slug raises
-- unique_violation (23505) for the app to report.
create function public.create_workspace(p_name text, p_slug text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.workspaces;
begin
  if v_uid is null then
    raise exception 'sign in to create a workspace'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.workspaces (name, slug, created_by, is_personal)
  values (btrim(p_name), p_slug, v_uid, false)
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.create_workspace(text, text) from public, anon;
grant execute on function public.create_workspace(text, text) to authenticated, service_role;

-- New accounts get their personal workspace as they are created, whichever
-- way they sign up: the email form, /api/auth/wallet's admin createUser, or
-- passkeys (which are email accounts). doqtri had no trigger on auth.users
-- before this one.
create function public.handle_new_user_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_personal_workspace(new.id);
  return new;
end;
$$;

create trigger on_auth_user_created_workspace
  after insert on auth.users
  for each row execute function public.handle_new_user_workspace();

-- Settles an account's workspaces before the account is deleted (D-31).
--
-- Its personal workspace is deleted, with its memberships. Nobody else owns
-- it (D-30) and `on delete set null` would otherwise leave it behind with no
-- owner and its members still in it. No document references a workspace
-- yet: documents still belong to their user and go with the account through
-- documents.user_id, exactly as before this migration. WP-1.2 must decide
-- what deleting a personal workspace does to the documents in it when it
-- adds documents.workspace_id, since this trigger will then reach them.
--
-- In every team workspace where the account is the last owner, the admin
-- who joined earliest becomes owner, so the workspace and (after WP-1.2) its
-- documents keep someone in charge. Where there is no admin, the deletion is
-- refused with restrict_violation, as a foreign key `on delete restrict`
-- would refuse it, naming the workspace: the account must first make another
-- member an owner or admin. Editors and viewers are never promoted.
--
-- "Joined earliest" is trustworthy because no client writes joined_at
-- (workspace_members_before_write).
--
-- A before trigger, so it runs while the account's rows are still in place
-- and before any cascade. Each workspace row is locked first, as
-- workspace_members_keep_owner does, so a concurrent change of owners waits.
-- Then every admin row of the workspace is locked, and only after that is the
-- earliest one picked: an admin being demoted or removed by a transaction
-- still in flight is waited for and then skipped, where `limit 1 for update`
-- would wait for that one row, find it no longer an admin, and return none,
-- refusing the deletion although another admin is there. Holding those locks
-- also makes any demotion or removal of an admin wait for this deletion.
-- Should the promotion be lost to a concurrent write anyway, the cascade
-- that removes the account's memberships trips workspace_members_keep_owner
-- and the deletion fails instead of leaving the workspace ownerless.
--
-- Security definer because it changes other users' memberships, deletes a
-- workspace no client may delete, and runs as whichever role deletes the
-- account (Supabase's auth admin).
create function public.handle_deleted_user_workspaces()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws    record;
  v_admin uuid;
begin
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
  end loop;

  return old;
end;
$$;

create trigger on_auth_user_deleted_workspaces
  before delete on auth.users
  for each row execute function public.handle_deleted_user_workspaces();

-- Trigger functions and the internal helpers are called by Postgres or by
-- other functions here, never by a client.
revoke execute on function public.handle_new_workspace() from public, anon, authenticated;
revoke execute on function public.workspaces_before_update() from public, anon, authenticated;
revoke execute on function public.workspace_members_keep_owner() from public, anon, authenticated;
revoke execute on function public.workspace_members_before_write() from public, anon, authenticated;
revoke execute on function public.handle_new_user_workspace() from public, anon, authenticated;
revoke execute on function public.handle_deleted_user_workspaces() from public, anon, authenticated;
revoke execute on function public.restore_personal_owner(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ensure_personal_workspace(uuid) from public, anon, authenticated;
grant execute on function public.ensure_personal_workspace(uuid) to service_role;


-- Backfill: a personal workspace for every existing account, oldest first.
-- ensure_personal_workspace() is a no-op for an account that already has one,
-- so re-running this is safe. This covers every user, not only those who own
-- documents, so the rule "every account has a personal workspace" holds the
-- same for old and new accounts.
select count(public.ensure_personal_workspace(u.id))
  from (select id from auth.users order by created_at) u;

-- Fail the migration, and so roll all of it back, if any account that owns a
-- document was missed: WP-1.2 moves documents into these workspaces and must
-- find one for every owner.
do $$
begin
  if exists (
    select 1 from public.documents d
     where not exists (
       select 1
         from public.workspaces w
         join public.workspace_members m
           on m.workspace_id = w.id and m.user_id = w.created_by and m.role = 'owner'
        where w.is_personal and w.created_by = d.user_id
     )
  ) then
    raise exception 'workspace backfill missed a document owner';
  end if;
end;
$$;
