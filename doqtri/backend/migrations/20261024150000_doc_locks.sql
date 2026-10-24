-- Edit locking for documents (WP-1.6, D-17).
--
-- A document is one markdown blob, and teammates of a workspace may all edit
-- it. Rather than merge concurrent edits, one person edits at a time: they
-- hold the document's edit lock, and everyone else reads. Confluence Cloud
-- co-edits live; locking is the simpler rule for one blob per document.
--
--   take      an editor or above takes a free lock, or renews their own
--             (the same call: a renewal is a take by the holder)
--   heartbeat the holder's client renews every minute while they edit. A lock
--             whose heartbeat is older than ten minutes is free: anyone
--             entitled may take it (doc_lock_idle_timeout())
--   release   the holder gives it up, when they leave the note
--   take over an admin or owner of the workspace takes a lock someone else
--             holds, whatever its age
--
-- doc_locks has no write policies: every change goes through the security
-- definer functions below, which check the caller's role first. Members of
-- the workspace, viewers included, read who holds a document's lock, so the
-- editor can say "<name> is editing".
--
-- Saving. documents.version counts saves: it starts at 1 and goes up by one
-- every time the markdown changes, whoever changes it. The browser saves only
-- through save_document(), which refuses the save unless the caller holds a
-- live lock (DQLCK) and the caller's copy is based on the current version
-- (DQVER), so nothing anyone else saved is overwritten. A lock that lapsed
-- while its holder was away, and that someone else then took and released,
-- is the case the version check is for: the holder's tab may take the lock
-- again, but its text is old, and the save is refused.
--
-- Direct updates of `markdown` by a client role (anon, authenticated) are
-- refused outright: a plain UPDATE cannot carry the version the client's
-- copy is based on, so it could not be checked. Every other column is still
-- written under the WP-1.2 policies (a rename is a title update). The service
-- role is not stopped by the trigger; routes that write markdown with it must
-- check the lock themselves, and the one that did (/api/regenerate) now saves
-- through save_document() as the user instead.
--
-- Removing or demoting a member drops the locks they hold in that workspace
-- at once (D-16), so a removed editor does not keep a note locked for ten
-- minutes after they lost access.
--
-- Personal workspaces work the same way. With only the owner in one, the
-- owner always finds the lock free or their own.

alter table public.documents
  add column version bigint not null default 1 check (version >= 1);

comment on column public.documents.version is
  'Save counter: 1 at creation, +1 on every markdown change. Checked by save_document(). Not the on-chain anchor version.';

create table public.doc_locks (
  document_id  uuid primary key references public.documents(id) on delete cascade,
  -- Deleting an account frees what it held.
  holder       uuid not null references auth.users(id) on delete cascade,
  -- When the current holder took it. Kept across renewals.
  acquired_at  timestamptz not null default now(),
  -- When the holder last showed they were editing. Older than
  -- doc_lock_idle_timeout() means the lock is free.
  heartbeat_at timestamptz not null default now()
);

comment on table public.doc_locks is
  'Who is editing a document (D-17). Written only by take_doc_lock(), release_doc_lock() and save_document().';

-- "Which locks does this member hold", for dropping them on removal.
create index doc_locks_holder_idx on public.doc_locks (holder);

alter table public.doc_locks enable row level security;

-- Members of the document's workspace read its lock. No insert, update or
-- delete policy: the functions below are the only writers.
create policy "doc locks - select as viewer" on public.doc_locks
  for select to authenticated
  using (exists (
    select 1 from public.documents d
     where d.id = document_id
       and public.is_workspace_member(d.workspace_id, 'viewer')
  ));

revoke insert, update, delete, truncate on public.doc_locks from anon, authenticated;


-- How long a lock lasts without a heartbeat. The client heartbeats every
-- minute (lib/doc-lock.ts), so ten is generous for a slow network and short
-- enough that a closed laptop does not keep a note locked for long.
create function public.doc_lock_idle_timeout()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '10 minutes';
$$;

revoke execute on function public.doc_lock_idle_timeout() from public, anon;
grant execute on function public.doc_lock_idle_timeout() to authenticated, service_role;


-- What the editor shows about a lock, from the caller's side.
--
--   holder          null when the lock is free (no row, or lapsed)
--   holder_name     how to name the holder in "<name> is editing"
--   mine            the caller holds it
--   can_edit        the caller is an editor or above, so may take a free lock
--   can_take_over   the caller is an admin or above, so may take a held one
--   version         the document's current save version, so a client knows
--                   when its copy is behind
create type public.doc_lock_status as (
  document_id   uuid,
  holder        uuid,
  holder_name   text,
  acquired_at   timestamptz,
  heartbeat_at  timestamptz,
  expires_at    timestamptz,
  mine          boolean,
  can_edit      boolean,
  can_take_over boolean,
  version       bigint
);

-- The name "<name> is editing" shows: the local part of the account's email,
-- as WP-1.1 names personal workspaces. Wallet accounts have a synthetic
-- email (`<G-address>@stellar.doqtri.local`, lib/wallet-auth.ts), so they are
-- named by their shortened address instead, which teammates already see on
-- anchored notes. Null when the account has no email.
--
-- Security definer to read auth.users. Internal: only doc_lock_status_for()
-- calls it, and only for the holder of a lock the caller may see.
create function public.doc_lock_holder_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when u.email is null then null
    when lower(u.email) like '%@stellar.doqtri.local' then
      upper(left(split_part(u.email, '@', 1), 4)) || '…' ||
      upper(right(split_part(u.email, '@', 1), 4))
    else nullif(split_part(u.email, '@', 1), '')
  end
    from auth.users u
   where u.id = p_user_id;
$$;

-- The lock status of p_document_id for the calling user, who must be a
-- member of its workspace. Raises no_data_found (P0002) for a document that
-- does not exist or that the caller cannot see: the two are not told apart.
--
-- Security definer to read the lock and the holder's name whatever the
-- caller's role, and to be callable from take_doc_lock() after its write.
create function public.doc_lock_status_for(p_document_id uuid)
returns public.doc_lock_status
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_doc  record;
  v_lock record;
  v_out  public.doc_lock_status;
begin
  select d.id, d.workspace_id, d.version into v_doc
    from public.documents d
   where d.id = p_document_id;
  if v_doc.id is null or v_uid is null
     or not public.is_workspace_member(v_doc.workspace_id, 'viewer')
  then
    raise exception 'note not found' using errcode = 'no_data_found';
  end if;

  select l.holder, l.acquired_at, l.heartbeat_at into v_lock
    from public.doc_locks l
   where l.document_id = p_document_id
     and l.heartbeat_at > now() - public.doc_lock_idle_timeout();

  v_out.document_id   := p_document_id;
  v_out.holder        := v_lock.holder;
  v_out.holder_name   := case when v_lock.holder is not null
                              then public.doc_lock_holder_name(v_lock.holder) end;
  v_out.acquired_at   := v_lock.acquired_at;
  v_out.heartbeat_at  := v_lock.heartbeat_at;
  v_out.expires_at    := v_lock.heartbeat_at + public.doc_lock_idle_timeout();
  v_out.mine          := v_lock.holder is not null and v_lock.holder = v_uid;
  v_out.can_edit      := public.is_workspace_member(v_doc.workspace_id, 'editor');
  v_out.can_take_over := public.is_workspace_member(v_doc.workspace_id, 'admin');
  v_out.version       := v_doc.version;
  return v_out;
end;
$$;

-- Takes or renews the edit lock on p_document_id for the calling user and
-- returns the lock status afterwards. Read `mine`: false means someone else
-- holds a live lock, which is not an error (the editor goes read-only and
-- names them).
--
--   free (no row, or heartbeat older than the timeout)   taken
--   held by the caller                                   renewed: heartbeat
--                                                        now, acquired_at kept
--   held by someone else, live                           left alone, unless
--                                                        p_takeover
--
-- Editors and above only (insufficient_privilege, 42501, for a viewer).
-- p_takeover is for admins and owners only (42501 for anyone else, even when
-- the lock happens to be free, so the client learns the rule at once).
-- Unknown or invisible documents raise no_data_found (P0002).
--
-- The insert's `on conflict ... do update ... where` decides atomically: two
-- editors taking a free lock at once both reach the same row, the second
-- waits for the first, sees it held and live, and gets mine = false.
create function public.take_doc_lock(p_document_id uuid, p_takeover boolean default false)
returns public.doc_lock_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ws  uuid;
begin
  select d.workspace_id into v_ws from public.documents d where d.id = p_document_id;
  if v_ws is null or v_uid is null or not public.is_workspace_member(v_ws, 'viewer') then
    raise exception 'note not found' using errcode = 'no_data_found';
  end if;
  if not public.is_workspace_member(v_ws, 'editor') then
    raise exception 'you can read this note but not edit it'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_takeover, false) and not public.is_workspace_member(v_ws, 'admin') then
    raise exception 'only an admin of the workspace can take over a note someone is editing'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.doc_locks as l (document_id, holder, acquired_at, heartbeat_at)
  values (p_document_id, v_uid, now(), now())
  on conflict (document_id) do update
     set holder       = excluded.holder,
         acquired_at  = case when l.holder = excluded.holder
                                  and l.heartbeat_at > now() - public.doc_lock_idle_timeout()
                             then l.acquired_at else now() end,
         heartbeat_at = now()
   where l.holder = excluded.holder
      or l.heartbeat_at <= now() - public.doc_lock_idle_timeout()
      or coalesce(p_takeover, false);

  return public.doc_lock_status_for(p_document_id);
end;
$$;

-- Gives up the caller's lock on p_document_id. True when they held one
-- (live or lapsed) and it is now gone; false otherwise, including when
-- someone else holds it. No role check: anyone may let go of their own lock,
-- which is all this can do.
create function public.release_doc_lock(p_document_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return false;
  end if;
  delete from public.doc_locks l
   where l.document_id = p_document_id and l.holder = v_uid;
  return found;
end;
$$;

-- Saves p_markdown as the text of p_document_id and returns its new version.
--
-- Refused, writing nothing, unless all hold:
--   the caller can see the document          else no_data_found (P0002)
--   the caller is an editor or above         else insufficient_privilege (42501)
--   the caller holds a live lock on it       else DQLCK
--   p_base_version is its current version    else DQVER
-- The document row is locked first, so two saves cannot both pass the version
-- check. A save is editing, so it also renews the lock's heartbeat. Saving
-- text identical to what is stored writes nothing and returns the current
-- version.
--
-- The custom SQLSTATEs reach the client as the error's `code`: DQLCK is
-- answered 423 by /api/notes/[id], DQVER 409.
create function public.save_document(
  p_document_id  uuid,
  p_markdown     text,
  p_base_version bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_doc     record;
  v_version bigint;
begin
  select d.id, d.workspace_id, d.markdown, d.version into v_doc
    from public.documents d
   where d.id = p_document_id
     for update;
  if v_doc.id is null or v_uid is null or not public.is_workspace_member(v_doc.workspace_id, 'viewer') then
    raise exception 'note not found' using errcode = 'no_data_found';
  end if;
  if not public.is_workspace_member(v_doc.workspace_id, 'editor') then
    raise exception 'you can read this note but not edit it'
      using errcode = 'insufficient_privilege';
  end if;
  if p_markdown is null then
    raise exception 'a note''s text cannot be null' using errcode = 'not_null_violation';
  end if;

  update public.doc_locks l
     set heartbeat_at = now()
   where l.document_id = p_document_id
     and l.holder = v_uid
     and l.heartbeat_at > now() - public.doc_lock_idle_timeout();
  if not found then
    raise exception 'you are not holding the edit lock on this note'
      using errcode = 'DQLCK',
            hint = 'Take the lock (take_doc_lock) before saving.';
  end if;

  if p_base_version is distinct from v_doc.version then
    raise exception 'this note was saved elsewhere since your copy was loaded (version % now, yours %)',
      v_doc.version, p_base_version
      using errcode = 'DQVER',
            detail = v_doc.version::text,
            hint = 'Reload the note before saving again.';
  end if;

  if p_markdown = v_doc.markdown then
    return v_doc.version;
  end if;

  update public.documents d
     set markdown = p_markdown, updated_at = now()
   where d.id = p_document_id
  returning d.version into v_version;
  return v_version;
end;
$$;

revoke execute on function public.doc_lock_holder_name(uuid) from public, anon, authenticated;
revoke execute on function public.doc_lock_status_for(uuid) from public, anon;
grant execute on function public.doc_lock_status_for(uuid) to authenticated;
revoke execute on function public.take_doc_lock(uuid, boolean) from public, anon;
grant execute on function public.take_doc_lock(uuid, boolean) to authenticated;
revoke execute on function public.release_doc_lock(uuid) from public, anon;
grant execute on function public.release_doc_lock(uuid) to authenticated;
revoke execute on function public.save_document(uuid, text, bigint) from public, anon;
grant execute on function public.save_document(uuid, text, bigint) to authenticated;


-- Keeps documents.version true and routes client saves through
-- save_document().
--
-- Every change of markdown, by any writer, bumps the version by one; a
-- version written without a markdown change is put back. A client role
-- changing markdown directly is refused: save_document() runs as its owner,
-- so it is not stopped here, and it has checked the lock and the version.
--
-- Not security definer: current_user must be the writer's own role. It reads
-- no tables. Fires before documents_before_update (triggers run in name
-- order); the two check different columns.
create function public.documents_before_save()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.markdown is distinct from old.markdown then
    if current_user in ('anon', 'authenticated') then
      raise exception 'a note''s text is saved through save_document(), which checks the edit lock and version'
        using errcode = 'insufficient_privilege';
    end if;
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

create trigger documents_before_save
  before update on public.documents
  for each row execute function public.documents_before_save();

-- Drops the locks a member holds in a workspace once they can no longer edit
-- in it: removed, or demoted to viewer (D-16). Their client finds out on its
-- next heartbeat or save.
--
-- Security definer: whoever removes the member cannot write doc_locks.
create function public.workspace_members_drop_locks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     or public.workspace_role_rank(new.role) < public.workspace_role_rank('editor')
  then
    delete from public.doc_locks l
     using public.documents d
     where l.document_id = d.id
       and d.workspace_id = old.workspace_id
       and l.holder = old.user_id;
  end if;
  return null;
end;
$$;

create trigger workspace_members_drop_locks
  after update of role or delete on public.workspace_members
  for each row execute function public.workspace_members_drop_locks();

revoke execute on function public.documents_before_save() from public, anon, authenticated;
revoke execute on function public.workspace_members_drop_locks() from public, anon, authenticated;
