-- Public read-only mindmap links, made on each "Send to qdit hackathon"
-- (WP-4.7, DOQ-53, QDIT-66).
--
-- Judges read a team's global mindmap from the PNG uploaded to qdit, and a
-- whole forest fitted into one image is unreadable. So every press of Send
-- now also stores the global mindmap exactly as sent (the snapshot's
-- `global_mindmap`) and the sender's `global` studio style, under a new
-- random token, and sends `mindmap_url` (<site>/m/<token>) in the snapshot.
-- /m/<token> draws that frozen copy, zoomable, for anyone with the link.
-- Later edits to the notes never change it.
--
--   token         at least 128 bits from a CSPRNG, base64url, 22 to 64
--                 characters (lib/mindmap-share.ts makes 32). It is the only
--                 secret: anyone holding the link sees the map's labels.
--   workspace_id  whose map it is. Deleting the workspace deletes its links.
--   created_by    who pressed Send. `on delete set null`: deleting an account
--                 anonymises it and keeps what it made (D-63), links included.
--   snapshot_id   the snapshot the link went out in, one link per snapshot.
--   graph         the snapshot's global_mindmap: { nodes: [{ id, label, kind,
--                 depth, doc_ids }], links: [{ source, target }] }. Labels
--                 are note titles, headings and concept names; no markdown.
--   style         the sender's `global` mindmap_styles row as parsed when
--                 sent (per-node overrides keyed by the graph's ids), or null.
--   revoked_at    set once the link is revoked, and never cleared.
--
-- Who can do what:
--
--   anon           nothing on the table. The page reads through
--                  mindmap_share(token), which answers only a link that is
--                  not revoked, and only its labels, kinds, depths, links and
--                  style: never doc_ids, the workspace, the sender or the
--                  snapshot id. mindmap_share_live(token) is the same check
--                  as a boolean, for proxy.ts, which turns an unknown or
--                  revoked token into a real 404 before the page streams.
--   authenticated  a workspace admin or owner selects their workspace's links
--                  and revokes them (UPDATE of revoked_at only, a column
--                  grant). Viewers and editors see none. Nobody un-revokes
--                  or back-dates: mindmap_shares_before_update keeps the
--                  first revoked_at and stamps it with now().
--   service_role   inserts (POST /api/integrations/qdit/hackathon, after it
--                  has checked the sender is a workspace admin, D-10) and
--                  revokes the link of a push that failed, so no link that
--                  qdit never got stays live. There is no client insert: the
--                  map's content always comes from the server's own build of
--                  the snapshot, never from what a browser sends.

create table public.mindmap_shares (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique check (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by   uuid references auth.users(id) on delete set null,
  snapshot_id  uuid not null unique,
  graph        jsonb not null check (
    jsonb_typeof(graph) = 'object'
    and jsonb_typeof(graph -> 'nodes') = 'array'
    and jsonb_typeof(graph -> 'links') = 'array'
    and octet_length(graph::text) <= 2097152
  ),
  style        jsonb check (
    style is null or (jsonb_typeof(style) = 'object' and octet_length(style::text) <= 65536)
  ),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

-- The dialog's list: this workspace's links, newest first.
create index mindmap_shares_workspace_idx on public.mindmap_shares (workspace_id, created_at desc);

alter table public.mindmap_shares enable row level security;

create policy "workspace admins - select" on public.mindmap_shares
  for select to authenticated
  using (public.is_workspace_member(workspace_id, 'admin'));

create policy "workspace admins - revoke" on public.mindmap_shares
  for update to authenticated
  using (public.is_workspace_member(workspace_id, 'admin'))
  with check (public.is_workspace_member(workspace_id, 'admin'));

revoke all on table public.mindmap_shares from public, anon, authenticated;
grant select on table public.mindmap_shares to authenticated;
grant update (revoked_at) on table public.mindmap_shares to authenticated;
grant all on table public.mindmap_shares to service_role;

-- Revoking is one-way: a revoked link stays revoked at the time it was first
-- revoked, and a new revocation is stamped now(), whatever the update said.
create function public.mindmap_shares_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null then
    new.revoked_at := old.revoked_at;
  elsif new.revoked_at is not null then
    new.revoked_at := now();
  end if;
  return new;
end;
$$;

create trigger mindmap_shares_before_update
  before update on public.mindmap_shares
  for each row execute function public.mindmap_shares_before_update();

revoke execute on function public.mindmap_shares_before_update() from public, anon, authenticated;

-- The public page's read. Security definer so anon needs no table access; to
-- keep that safe it takes only the token, answers nothing for a malformed,
-- unknown or revoked one, and returns labels only (each node's id, label,
-- kind and depth, each link's ends) plus the style.
create function public.mindmap_share(p_token text)
returns table (graph jsonb, style jsonb, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select
    jsonb_build_object(
      'nodes', coalesce((
        select jsonb_agg(
                 jsonb_build_object('id', n -> 'id', 'label', n -> 'label', 'kind', n -> 'kind', 'depth', n -> 'depth')
                 order by e.ord)
          from jsonb_array_elements(s.graph -> 'nodes') with ordinality as e(n, ord)
      ), '[]'::jsonb),
      'links', coalesce((
        select jsonb_agg(jsonb_build_object('source', l -> 'source', 'target', l -> 'target') order by e.ord)
          from jsonb_array_elements(s.graph -> 'links') with ordinality as e(l, ord)
      ), '[]'::jsonb)
    ),
    s.style,
    s.created_at
  from public.mindmap_shares s
  where p_token ~ '^[A-Za-z0-9_-]{22,64}$'
    and s.token = p_token
    and s.revoked_at is null;
$$;

-- Whether a link is live: what proxy.ts asks before /m/<token> renders.
create function public.mindmap_share_live(p_token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.mindmap_shares s
     where p_token ~ '^[A-Za-z0-9_-]{22,64}$'
       and s.token = p_token
       and s.revoked_at is null
  );
$$;

revoke execute on function public.mindmap_share(text) from public;
grant execute on function public.mindmap_share(text) to anon, authenticated, service_role;
revoke execute on function public.mindmap_share_live(text) from public;
grant execute on function public.mindmap_share_live(text) to anon, authenticated, service_role;
