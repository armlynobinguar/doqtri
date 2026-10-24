-- Documents belong to workspaces (WP-1.2).
--
-- Until now a document belonged to one user (`documents.user_id`) and every
-- policy on it, and on the tables hanging off it, was `auth.uid() = user_id`.
-- This moves ownership up a level: every document gets a `workspace_id`, and
-- who may read or change it follows the caller's role in that workspace
-- (20261024120000_create_workspaces.sql):
--
--   viewer  reads the workspace's documents and their GitHub links (D-14)
--   editor  also creates, edits and deletes them, and links nodes to GitHub
--   admin   as editor (plus member management, from WP-1.1)
--   owner   as admin
--
-- `user_id` stays, as the document's author: whoever created it. It no longer
-- decides access. It becomes nullable, `on delete set null`, so that an
-- author deleting their account leaves the documents they wrote in a team
-- workspace with the team instead of taking them along. Documents in the
-- account's personal workspace still go with it: see
-- handle_deleted_user_workspaces() below.
--
-- Backfill: each existing document moves to its author's personal workspace,
-- which WP-1.1 created for every account and of which the author is the only
-- owner (D-30). Nobody else can read it yet, since nobody else is a member,
-- so no document becomes reachable by anyone new, and none becomes
-- unreachable for its author.
--
-- Titles are the graph's join key and the app compares them case- and
-- trim-insensitively (lib/title.ts). They were never unique in the database,
-- only kept unique by the app, per user. They are now unique per workspace,
-- enforced by an index, because teammates create notes in one workspace
-- concurrently. Pairs that slipped past the app's check are renamed first,
-- the way the app would have named them ("Plan 2"); see the dedupe below.
--
-- Tables keyed by a document, classified from every earlier migration:
--
--   follows the document's workspace
--     node_links        viewer+ read, editor+ insert/update/delete. user_id
--                       is who made the link, nullable like documents.user_id
--
--   stays per user, unchanged
--     ingests           an upload attempt is its uploader's record; written by
--                       the service role, read by the uploader
--     mindmap_styles    one user's styling of a map; only the doc check in
--                       its write policies changes, from "my document" to
--                       "a document I can read"
--     chain_writes      public select, unchanged: the ledger is public
--     market_templates  the creator's listing; service-role writes only
--
--   no document reference, unchanged
--     wallet_accounts, smart_wallets, wallet_passkeys, chain_usage, ai_usage,
--     promo_submissions, market_purchases, market_reports, referral_codes,
--     referrals, workspaces, workspace_members
--
-- Protections kept: an anchored document still cannot be deleted. The app
-- checks the ledger before deleting (/api/notes/[id]), and chain_writes'
-- `on delete restrict` still refuses the delete for any document a passkey
-- wallet anchored, whoever asks. The public audit page (/d/[docId]) reads
-- with the service role and is unaffected.

alter table public.documents
  add column workspace_id uuid references public.workspaces(id) on delete restrict;

comment on column public.documents.workspace_id is
  'The workspace this document belongs to; decides who can read and change it.';
comment on column public.documents.user_id is
  'The author: who created the document. Null once that account is deleted. Does not decide access.';


-- Backfill
--
-- ensure_personal_workspace() is a no-op for an account that already has its
-- workspace (WP-1.1 created one for every account), and the repair for one
-- that somehow does not, so this cannot leave a document behind.

select count(public.ensure_personal_workspace(d.user_id))
  from (select distinct user_id from public.documents) d;

update public.documents d
   set workspace_id = w.id
  from public.workspaces w
 where w.is_personal
   and w.created_by = d.user_id
   and d.workspace_id is null;

do $$
begin
  if exists (select 1 from public.documents where workspace_id is null) then
    raise exception 'workspace backfill left a document without a workspace';
  end if;
end;
$$;

alter table public.documents alter column workspace_id set not null;


-- Titles, unique per workspace
--
-- Duplicates within one workspace (two notes of one author whose titles
-- differ only by case or surrounding spaces, from before the app checked, or
-- from two requests racing) are renamed before the unique index is built.
-- The note edited longest ago keeps its title; each later one gets the
-- lowest free " <n>" suffix from 2 up, as uniqueTitle() in lib/title.ts
-- would have given it. Only `title` changes: the markdown is untouched, so an
-- anchored note's content hash still matches the ledger.

do $$
declare
  v_doc   record;
  v_n     integer;
  v_title text;
begin
  for v_doc in
    select x.id, x.workspace_id, btrim(x.title) as base
      from (
        select d.id, d.workspace_id, d.title, d.updated_at,
               row_number() over (
                 partition by d.workspace_id, lower(btrim(d.title))
                 order by d.updated_at, d.id
               ) as rn
          from public.documents d
      ) x
     where x.rn > 1
     order by x.workspace_id, x.updated_at, x.id
  loop
    v_n := 2;
    loop
      v_title := v_doc.base || ' ' || v_n;
      exit when not exists (
        select 1 from public.documents d
         where d.workspace_id = v_doc.workspace_id
           and lower(btrim(d.title)) = lower(v_title)
      );
      v_n := v_n + 1;
    end loop;
    update public.documents set title = v_title where id = v_doc.id;
    raise notice 'renamed duplicate title of document % to "%"', v_doc.id, v_title;
  end loop;
end;
$$;

drop index public.documents_user_title_idx;
create unique index documents_workspace_title_idx
  on public.documents (workspace_id, lower(btrim(title)));
-- Author lookups, and the `on delete set null` below.
create index documents_user_idx on public.documents (user_id);


-- Authors
--
-- Deleting an account must not delete what it wrote in team workspaces.

alter table public.documents alter column user_id drop not null;
alter table public.documents drop constraint documents_user_id_fkey;
alter table public.documents
  add constraint documents_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

alter table public.node_links alter column user_id drop not null;
alter table public.node_links drop constraint node_links_user_id_fkey;
alter table public.node_links
  add constraint node_links_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- A client can neither re-attribute a row nor move a document to another
-- workspace: the update policies below let editors write whole rows, and
-- authorship and placement are not theirs to change. Moving a document
-- between workspaces is left to the service role, for whichever package
-- defines what a move does to its on-chain owner (D-28).
--
-- Not security definer: current_user must be the writer's own role. The
-- `on delete set null` actions run as the table owner, so they pass.
create function public.documents_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.user_id is distinct from old.user_id
          or new.workspace_id is distinct from old.workspace_id)
  then
    raise exception 'a document''s author and workspace cannot be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger documents_before_update
  before update on public.documents
  for each row execute function public.documents_before_update();

create function public.node_links_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and new.user_id is distinct from old.user_id
  then
    raise exception 'a node link''s author cannot be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger node_links_before_update
  before update on public.node_links
  for each row execute function public.node_links_before_update();

revoke execute on function public.documents_before_update() from public, anon, authenticated;
revoke execute on function public.node_links_before_update() from public, anon, authenticated;


-- documents
--
-- Every clause goes through is_workspace_member(), so a member who is
-- removed or demoted loses access with the very next query (D-16). A new
-- document is always the caller's own (user_id), in a workspace where they
-- are an editor or above.

drop policy "own docs - select" on public.documents;
drop policy "own docs - insert" on public.documents;
drop policy "own docs - update" on public.documents;
drop policy "own docs - delete" on public.documents;

create policy "workspace docs - select as viewer" on public.documents
  for select to authenticated
  using (public.is_workspace_member(workspace_id, 'viewer'));
create policy "workspace docs - insert as editor" on public.documents
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_workspace_member(workspace_id, 'editor')
  );
create policy "workspace docs - update as editor" on public.documents
  for update to authenticated
  using (public.is_workspace_member(workspace_id, 'editor'))
  with check (public.is_workspace_member(workspace_id, 'editor'));
create policy "workspace docs - delete as editor" on public.documents
  for delete to authenticated
  using (public.is_workspace_member(workspace_id, 'editor'));


-- node_links
--
-- A link is part of its document: whoever can read the document reads its
-- links, and its editors make, change and remove them, including links a
-- teammate made. A new link is the caller's own (user_id).

drop policy "own node links - select" on public.node_links;
drop policy "own node links - insert" on public.node_links;
drop policy "own node links - delete" on public.node_links;

create policy "workspace node links - select as viewer" on public.node_links
  for select to authenticated
  using (exists (
    select 1 from public.documents d
     where d.id = document_id
       and public.is_workspace_member(d.workspace_id, 'viewer')
  ));
create policy "workspace node links - insert as editor" on public.node_links
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.documents d
       where d.id = document_id
         and public.is_workspace_member(d.workspace_id, 'editor')
    )
  );
create policy "workspace node links - update as editor" on public.node_links
  for update to authenticated
  using (exists (
    select 1 from public.documents d
     where d.id = document_id
       and public.is_workspace_member(d.workspace_id, 'editor')
  ))
  with check (exists (
    select 1 from public.documents d
     where d.id = document_id
       and public.is_workspace_member(d.workspace_id, 'editor')
  ));
create policy "workspace node links - delete as editor" on public.node_links
  for delete to authenticated
  using (exists (
    select 1 from public.documents d
     where d.id = document_id
       and public.is_workspace_member(d.workspace_id, 'editor')
  ));


-- mindmap_styles
--
-- Still one user's own rows. A style may be saved for any document the user
-- can read, a viewer's included: it changes only how that user sees the map.

drop policy "own mindmap styles - insert" on public.mindmap_styles;
drop policy "own mindmap styles - update" on public.mindmap_styles;

create policy "own mindmap styles - insert" on public.mindmap_styles
  for insert with check (
    (select auth.uid()) = user_id
    and (
      document_id is null
      or exists (
        select 1 from public.documents d
        where d.id = document_id
          and public.is_workspace_member(d.workspace_id, 'viewer')
      )
    )
  );
create policy "own mindmap styles - update" on public.mindmap_styles
  for update using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (
      document_id is null
      or exists (
        select 1 from public.documents d
        where d.id = document_id
          and public.is_workspace_member(d.workspace_id, 'viewer')
      )
    )
  );


-- Deleting an account
--
-- Same as WP-1.1's version, with one step added first: the documents in the
-- account's personal workspace are deleted, so the workspace can be (their
-- `workspace_id` is `on delete restrict`). Before this migration those
-- documents went with the account through documents.user_id; now they go
-- with its personal workspace, other members' documents in it included,
-- since the workspace itself is gone (D-30, D-31). An anchored one among them
-- still refuses the deletion through chain_writes, as before. Documents the
-- account wrote in team workspaces stay, with user_id cleared.

create or replace function public.handle_deleted_user_workspaces()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws    record;
  v_admin uuid;
begin
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
  end loop;

  return old;
end;
$$;

revoke execute on function public.handle_deleted_user_workspaces() from public, anon, authenticated;
