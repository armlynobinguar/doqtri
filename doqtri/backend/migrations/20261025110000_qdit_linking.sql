-- Linking notes and headings to qdit (WP-2.5).
--
-- docs/integration/CONTRACT.md is the reference for every rule here; section
-- numbers below point into it. Two things are linked:
--
--   doc_project_links  a note to one qdit project (D-09: a note has at most
--                      one project; a project holds many notes). Cached here
--                      from qdit's answer to POST /projects/{id}/docs, so the
--                      ship panel can name the project without a qdit token.
--   node_links         a heading to one qdit milestone, next to the existing
--                      GitHub links: a new `provider` column says which. A
--                      heading still has one link of one provider at most
--                      (D-08, unique (document_id, node_id)), and a milestone
--                      links to one heading at most (D-06).
--
-- Who may do what follows the note's workspace (WP-1.2): viewers read both
-- tables, editors link and unlink headings, and only admins and owners link
-- or unlink the note's project (D-10). What the caller's qdit role allows is
-- qdit's to decide (D-23).
--
-- qdit rows mirror state that lives in qdit (section 2). A row that qdit does
-- not know about, or that says something qdit was never told, would be
-- wrong in a way no doqtri user could see. So, as with qdit's own
-- project_doc_links (D-48), signed-in users never write these rows
-- directly: the integration routes do, with the service role, after the
-- workspace role check and only with what qdit answered. GitHub rows are
-- written from the browser, as before, and nothing about them changes.
--
-- Positional ids (R-03). node_id is `h<n>`, the heading's position, so
-- inserting a heading shifts every id after it. Every save works out which
-- linked headings moved or were renamed (lib/node-remap.ts, section 11) and
-- applies it here in one statement through apply_node_link_remap(), for
-- GitHub and qdit rows alike; qdit's copy is then brought up to date
-- through the API. qdit_state says how far that got:
--
--   linked     qdit agrees with this row
--   pending    doqtri moved or renamed the heading; qdit has not been told
--              yet (it is told after the save, and again on Retry)
--   ambiguous  the heading's text appears more than once; the owner relinks
--   broken     the heading was deleted, or qdit no longer has the link;
--              relink or unlink. The milestone is never deleted (D-03)
--   conflict   qdit already holds another milestone on that heading
--
-- Only headings get links (D-11): `root` or `h<n>` for GitHub, as the ship
-- panel always offered, and `h<n>` only for qdit, whose milestones stand for
-- parts of the plan (the note itself is what links to the project, and the
-- root node rolls up from its children, D-24). Concept-map nodes (c<n>)
-- never do. The check is NOT VALID so that a stray row written straight
-- through PostgREST before now cannot stop the migration; it holds for
-- every row written from here on.

-- ---------------------------------------------------------------------------
-- doc_project_links
-- ---------------------------------------------------------------------------

create table public.doc_project_links (
  document_id      uuid primary key references public.documents(id) on delete cascade,
  -- qdit's projects.id.
  project_id       uuid not null,
  -- The project's name and slug (qdit's key) as qdit last reported them.
  project_name     text not null check (char_length(project_name) between 1 and 300),
  project_slug     text not null check (char_length(project_slug) between 1 and 300),
  project_url      text check (project_url is null or project_url ~ '^https?://'),
  -- qdit's project_doc_links.id for this note.
  qdit_link_id     uuid not null,
  -- The doc_url doqtri sent: its own origin and the note's path (D-45).
  doc_url          text not null check (doc_url ~ '^https?://'),
  linked_by        uuid references auth.users(id) on delete set null,
  -- One sync of this note's milestone links to qdit at a time; see
  -- claim_qdit_link_sync().
  sync_lease       uuid,
  sync_lease_until timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The target of node_links' project reference below.
  unique (document_id, project_id)
);

comment on table public.doc_project_links is
  'The qdit project a note is linked to (WP-2.5, D-09). Written by the integration routes only.';

alter table public.doc_project_links enable row level security;

create policy "workspace doc project links - select as viewer" on public.doc_project_links
  for select to authenticated
  using (exists (
    select 1 from public.documents d
     where d.id = document_id
       and public.is_workspace_member(d.workspace_id, 'viewer')
  ));

-- No write policy, and no write privilege either: a policy added by mistake
-- later still lets nobody but the service role write.
revoke all on table public.doc_project_links from public, anon, authenticated;
grant select on table public.doc_project_links to authenticated;
grant select, insert, update, delete on table public.doc_project_links to service_role;

-- A linked note is not deleted. qdit holds a link back to it and, for each
-- linked heading, a milestone link that keeps the milestone's title
-- read-only there (D-12). If the note went, the cascade would drop doqtri's
-- rows, ids included, and nothing could take qdit's out again: qdit leaves
-- unlinking to doqtri (D-10). So an admin unlinks the project first, and
-- until then every path is refused: the note route (which says so before
-- it gets here), a delete straight through PostgREST, and the account
-- deletion that takes a personal workspace's notes with it, which this
-- rolls back as D-39's refusals do.
create function public.refuse_qdit_linked_document_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project text;
begin
  select l.project_name into v_project
    from public.doc_project_links l
   where l.document_id = old.id;
  if found then
    raise exception 'note % is linked to the qdit project "%"', old.id, v_project
      using errcode = 'restrict_violation',
            hint = 'A workspace admin must unlink the qdit project first, so qdit drops its links too.';
  end if;
  return old;
end;
$$;

revoke all on function public.refuse_qdit_linked_document_delete() from public, anon, authenticated;

create trigger documents_refuse_qdit_linked_delete
  before delete on public.documents
  for each row execute function public.refuse_qdit_linked_document_delete();


-- ---------------------------------------------------------------------------
-- node_links: provider
-- ---------------------------------------------------------------------------

alter table public.node_links
  add column provider text not null default 'github'
    check (provider in ('github', 'qdit')),
  alter column repo drop not null,
  alter column number drop not null,
  add column qdit_project_id   uuid,
  add column qdit_milestone_id uuid,
  -- qdit's milestone_external_links.id, the {id} of PATCH and DELETE /links.
  add column qdit_link_id      uuid,
  add column qdit_url          text check (qdit_url is null or qdit_url ~ '^https?://'),
  -- The note's DoqtriRegistry version qdit's copy was last written against.
  add column qdit_doc_version  integer check (qdit_doc_version is null or qdit_doc_version >= 1),
  add column qdit_state        text
    check (qdit_state in ('linked', 'pending', 'ambiguous', 'broken', 'conflict')),
  -- What the contract calls the row's external_ref (section 2).
  add column external_ref      text generated always as (
    case when provider = 'qdit' then qdit_project_id::text || '/' || qdit_milestone_id::text end
  ) stored;

comment on column public.node_links.provider is
  'github (repo, number) or qdit (qdit_* columns). One link per heading, of one provider (D-08).';
comment on column public.node_links.qdit_state is
  'linked | pending | ambiguous | broken | conflict: whether qdit agrees with this row (WP-2.5).';

alter table public.node_links
  add constraint node_links_provider_columns check (
    case provider
      when 'github' then repo is not null and number is not null
        and qdit_project_id is null and qdit_milestone_id is null and qdit_link_id is null
        and qdit_url is null and qdit_doc_version is null and qdit_state is null
      when 'qdit' then repo is null and number is null
        and qdit_project_id is not null and qdit_milestone_id is not null
        and qdit_link_id is not null and qdit_state is not null
    end
  );

alter table public.node_links
  add constraint node_links_heading_node check (
    node_id ~ '^(root|h(0|[1-9][0-9]{0,8}))$'
    and (provider <> 'qdit' or node_id <> 'root')
  ) not valid;

-- A qdit link belongs to the note's project: unlinking the note from it
-- takes every milestone link with it, as qdit does in the same transaction
-- (D-22). GitHub rows have no project, so the reference does not apply.
alter table public.node_links
  add constraint node_links_qdit_project_fkey
  foreign key (document_id, qdit_project_id)
  references public.doc_project_links (document_id, project_id) on delete cascade;

-- One milestone, one heading (D-06), and one row per qdit link.
create unique index node_links_qdit_milestone_idx
  on public.node_links (qdit_milestone_id) where provider = 'qdit';
create unique index node_links_qdit_link_idx
  on public.node_links (qdit_link_id) where provider = 'qdit';

-- Still one link per heading (D-08), now checked at the end of each
-- statement rather than row by row, so that apply_node_link_remap() can
-- move two links past each other (a swap) in one update.
alter table public.node_links drop constraint node_links_document_id_node_id_key;
alter table public.node_links
  add constraint node_links_document_id_node_id_key
  unique (document_id, node_id) deferrable initially immediate;


-- Client writes: GitHub rows only
--
-- The WP-1.2 policies, each narrowed to provider = 'github'. Editors still
-- make, change and remove GitHub links, a teammate's included, and cannot
-- turn one into a qdit row or touch a qdit row at all.

drop policy "workspace node links - insert as editor" on public.node_links;
drop policy "workspace node links - update as editor" on public.node_links;
drop policy "workspace node links - delete as editor" on public.node_links;

create policy "workspace node links - insert github as editor" on public.node_links
  for insert to authenticated
  with check (
    provider = 'github'
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.documents d
       where d.id = document_id
         and public.is_workspace_member(d.workspace_id, 'editor')
    )
  );
create policy "workspace node links - update github as editor" on public.node_links
  for update to authenticated
  using (provider = 'github' and exists (
    select 1 from public.documents d
     where d.id = document_id
       and public.is_workspace_member(d.workspace_id, 'editor')
  ))
  with check (provider = 'github' and exists (
    select 1 from public.documents d
     where d.id = document_id
       and public.is_workspace_member(d.workspace_id, 'editor')
  ));
create policy "workspace node links - delete github as editor" on public.node_links
  for delete to authenticated
  using (provider = 'github' and exists (
    select 1 from public.documents d
     where d.id = document_id
       and public.is_workspace_member(d.workspace_id, 'editor')
  ));


-- ---------------------------------------------------------------------------
-- Functions (service role only)
-- ---------------------------------------------------------------------------

-- Applies one save's remap: each change gives a link's new node_id and,
-- optionally, its new label and qdit_state. p_version is the documents.version
-- the remap was worked out from; if the note has been saved again since,
-- nothing is written and null is returned, because the later save works out
-- its own remap from the newer text. The note's row is share-locked, so a
-- save cannot land between the check and the update. Otherwise returns the
-- number of links changed.
--
-- One update statement, so a swap passes the deferred unique check; any
-- other clash (two links on one heading) fails the whole call with 23505
-- and changes nothing.
create function public.apply_node_link_remap(
  p_document_id uuid,
  p_version     bigint,
  p_changes     jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version bigint;
  v_count   integer;
begin
  select d.version into v_version
    from public.documents d
   where d.id = p_document_id
     for share;
  if v_version is null or v_version is distinct from p_version then
    return null;
  end if;

  update public.node_links n
     set node_id    = c.node_id,
         node_label = coalesce(c.node_label, n.node_label),
         qdit_state = case when n.provider = 'qdit' then coalesce(c.qdit_state, n.qdit_state) end
    from jsonb_to_recordset(coalesce(p_changes, '[]'::jsonb))
         as c(id uuid, node_id text, node_label text, qdit_state text)
   where n.id = c.id
     and n.document_id = p_document_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.apply_node_link_remap(uuid, bigint, jsonb) is
  'Moves and renames a note''s node links after a save, if the note is still at p_version (WP-2.5, R-03).';

-- Takes the note's sync lease for p_seconds: true if it was free, expired,
-- or already this lease's. One sync at a time per note means two saves in
-- quick succession cannot reach qdit out of order and leave it with the
-- older title. A sync that finds the lease taken simply stops: the holder
-- reads the rows again before it lets go (lib/integrations/qdit-linking.ts).
create function public.claim_qdit_link_sync(
  p_document_id uuid,
  p_lease       uuid,
  p_seconds     integer default 60
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.doc_project_links l
       set sync_lease = p_lease,
           sync_lease_until = now() + make_interval(secs => greatest(1, least(p_seconds, 300)))
     where l.document_id = p_document_id
       and (l.sync_lease is null or l.sync_lease = p_lease or l.sync_lease_until < now())
    returning 1
  )
  select exists (select 1 from claimed)
$$;

create function public.release_qdit_link_sync(
  p_document_id uuid,
  p_lease       uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.doc_project_links l
     set sync_lease = null, sync_lease_until = null
   where l.document_id = p_document_id
     and l.sync_lease = p_lease
$$;

revoke all on function public.apply_node_link_remap(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.apply_node_link_remap(uuid, bigint, jsonb) to service_role;
revoke all on function public.claim_qdit_link_sync(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_qdit_link_sync(uuid, uuid, integer) to service_role;
revoke all on function public.release_qdit_link_sync(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_qdit_link_sync(uuid, uuid) to service_role;
