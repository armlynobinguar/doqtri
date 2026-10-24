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
-- The browser may create workspaces and manage members directly under RLS.
-- The membership checks follow qdit's project_members helpers (qdit
-- supabase/migrations/20260731133313_rls.sql); see is_workspace_member().

create type public.workspace_role as enum ('viewer', 'editor', 'admin', 'owner');

create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 100),
  -- Globally unique so a workspace URL needs no owner segment.
  slug        text not null unique check (
    char_length(slug) <= 64 and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  -- `on delete set null`: deleting an account must not take a team's
  -- workspace (and, after WP-1.2, its documents) with it.
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
-- Members read their workspaces. The creator can also read the row they
-- created: an insert that returns the row (`.insert().select()`) checks the
-- read policy before the trigger below has added their owner membership, so
-- without it creating a workspace from the browser would fail. A creator who
-- later leaves keeps seeing only the name and slug, never its documents.
--
-- Anyone signed in may create a workspace, as themselves and never a personal
-- one; on_workspace_created makes them its owner. Admins and owners rename it.
-- There is no delete policy: deleting a workspace will delete or orphan its
-- documents once WP-1.2 lands, so it stays with the service role until a
-- package decides what deletion means.

create policy "workspaces - select as member" on public.workspaces
  for select to authenticated
  using (
    public.is_workspace_member(id, 'viewer')
    or created_by = (select auth.uid())
  );
create policy "workspaces - insert as self" on public.workspaces
  for insert to authenticated
  with check (created_by = (select auth.uid()) and not is_personal);
create policy "workspaces - update as admin" on public.workspaces
  for update to authenticated
  using (public.is_workspace_member(id, 'admin'))
  with check (public.is_workspace_member(id, 'admin'));


-- workspace_members
--
-- Members read the roster of their own workspaces. Owners add, change and
-- remove anyone. Admins do the same for everyone but owners: they cannot
-- touch an owner's row (the USING clause sees the row as it is) and cannot
-- make anyone an owner (the WITH CHECK clause sees the row as it will be).
-- Anyone may remove their own row, i.e. leave. Viewers and editors cannot
-- change any row, their own included, so nobody promotes themselves.
--
-- Two rules RLS cannot express, because they depend on the other rows, are
-- enforced by workspace_members_keep_owner below for every writer, the
-- service role included: the last owner can neither leave nor be demoted,
-- and a row cannot be moved to another workspace or user.
--
-- Every clause goes through is_workspace_member() rather than querying
-- workspace_members inline; that is the recursion the helper exists to avoid.

create policy "workspace members - select as member" on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id, 'viewer'));
create policy "workspace members - insert as admin" on public.workspace_members
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id, 'owner')
    or (public.is_workspace_member(workspace_id, 'admin') and role <> 'owner')
  );
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
-- whole row, and these are not theirs to change. created_by may still become
-- null, which is the `on delete set null` of an account being deleted.
create function public.workspaces_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
     or new.is_personal <> old.is_personal
     or new.created_at <> old.created_at
     or (new.created_by is distinct from old.created_by and new.created_by is not null)
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

-- Keeps every workspace with at least one owner, and membership rows in place.
--
-- Runs after the statement's row change, so it sees the roster as the change
-- leaves it, and locks the workspace row first so two owners demoting each
-- other at once cannot both succeed. Two removals are let through: the
-- workspace itself being deleted (its rows cascade), and the member's account
-- being deleted (auth.users cascades). The second can leave a team workspace
-- with no owner; that is WP-1.5's to resolve along with member management.
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

  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then
    return null;
  end if;
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return null;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from auth.users u where u.id = old.user_id) then
    return null;
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
  after update or delete on public.workspace_members
  for each row execute function public.workspace_members_keep_owner();


-- The user's personal workspace, created on first call. Returns its id.
--
-- Named after the email's local part. Wallet accounts have a synthetic
-- address (`<G-address>@stellar.doqtri.local`, see lib/wallet-auth.ts) and
-- accounts may have no email at all; both are named "Personal". The slug is
-- random rather than derived from the email, so it does not leak the address
-- into URLs.
--
-- Security definer because it reads auth.users and creates a personal
-- workspace, which the insert policy refuses to everyone. Execute is granted
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
  return v_id;
end;
$$;

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

-- Trigger functions are called by Postgres, never by a client.
revoke execute on function public.handle_new_workspace() from public, anon, authenticated;
revoke execute on function public.workspaces_before_update() from public, anon, authenticated;
revoke execute on function public.workspace_members_keep_owner() from public, anon, authenticated;
revoke execute on function public.handle_new_user_workspace() from public, anon, authenticated;
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
