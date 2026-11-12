-- Mindmap links expire 24 hours after the hackathon's grades are released,
-- and qdit can ask whether a link is still live (WP-4.7, DOQ-54, QDIT-67).
--
-- DOQ-53 (20261112100000_mindmap_shares.sql, already applied) made one public
-- link per "Send to qdit hackathon", answered only by `revoked_at`. This adds:
--
--   mindmap_shares.hackathon_slug  the hackathon the link was sent to, from the
--                                  send route. Set once: never changed after.
--   mindmap_shares.expires_at      when the link stops working. null until qdit
--                                  says the grades are released. It only ever
--                                  moves earlier, and is never cleared.
--   qdit_hackathon_releases        per hackathon, when qdit said its grades
--                                  were released and when its links expire
--                                  (released_at + 24 hours). A link sent after
--                                  that is stamped with the same expiry when
--                                  it is stored. Service role only.
--   qdit_webhook_events            the webhook's idempotency store (WP-2.8)
--                                  takes `hackathon.released` events too.
--   record_qdit_hackathon_release  the webhook's write for that event.
--   mindmap_share_statuses         what POST /api/mindmap-links/status reads.
--   rate_limit_hits,               a fixed-window counter for public routes,
--   consume_rate_limit             first used by the status endpoint.
--   backfill_mindmap_share_hackathons
--                                  the operator's backfill of links sent
--                                  before this migration (see the end).
--
-- An expired link is treated as revoked everywhere: mindmap_share() answers
-- nothing and mindmap_share_live() false (so proxy.ts makes /m/<token> a 404
-- at once), the status endpoint answers live: false, and the dialog leaves it
-- out. now() >= expires_at is expired.

-- ---------------------------------------------------------------------------
-- mindmap_shares: the hackathon and the expiry
-- ---------------------------------------------------------------------------

alter table public.mindmap_shares
  add column hackathon_slug text check (hackathon_slug is null or hackathon_slug ~ '^[a-z0-9-]{1,64}$'),
  add column expires_at     timestamptz;

comment on column public.mindmap_shares.hackathon_slug is
  'The qdit hackathon the link was sent to (DOQ-54). Null only for links sent before it, until backfilled. Set once.';
comment on column public.mindmap_shares.expires_at is
  'When the link stops working: the hackathon''s released_at + 24 h (DOQ-54). Null until known. Only moves earlier.';

-- The webhook's update: every link of one hackathon.
create index mindmap_shares_hackathon_idx on public.mindmap_shares (hackathon_slug)
  where hackathon_slug is not null;

-- ---------------------------------------------------------------------------
-- qdit_hackathon_releases
-- ---------------------------------------------------------------------------

create table public.qdit_hackathon_releases (
  hackathon_slug text primary key check (hackathon_slug ~ '^[a-z0-9-]{1,64}$'),
  -- qdit's released_at, and the expiry it gives every link of the hackathon.
  released_at    timestamptz not null,
  expires_at     timestamptz not null,
  -- The event this came from (occurred_at orders events), or null when the
  -- operator recorded it with backfill_mindmap_share_hackathons().
  event_id       uuid,
  occurred_at    timestamptz not null,
  recorded_at    timestamptz not null default now(),
  constraint qdit_hackathon_releases_expiry check (expires_at <= released_at + interval '24 hours')
);

comment on table public.qdit_hackathon_releases is
  'Per qdit hackathon: when its grades were released and when its mindmap links expire (WP-4.7, DOQ-54). Service role only.';

alter table public.qdit_hackathon_releases enable row level security;
revoke all on table public.qdit_hackathon_releases from public, anon, authenticated;
grant select, insert, update, delete on table public.qdit_hackathon_releases to service_role;

-- ---------------------------------------------------------------------------
-- The triggers: one-way revoke, set-once hackathon, expiry only earlier
-- ---------------------------------------------------------------------------

-- The release's expiry for a link that names its hackathon now, so a link
-- stored (or backfilled) after the release still expires with the rest.
create function public.mindmap_shares_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_expires timestamptz;
begin
  if new.hackathon_slug is not null then
    select r.expires_at into v_expires
      from public.qdit_hackathon_releases r
     where r.hackathon_slug = new.hackathon_slug;
    if found then
      new.expires_at := least(coalesce(new.expires_at, v_expires), v_expires);
    end if;
  end if;
  return new;
end;
$$;

create trigger mindmap_shares_before_insert
  before insert on public.mindmap_shares
  for each row execute function public.mindmap_shares_before_insert();

revoke execute on function public.mindmap_shares_before_insert() from public, anon, authenticated;

-- DOQ-53's revoke rule, unchanged, plus: a hackathon, once named, stays; an
-- expiry, once set, can only move earlier and is never cleared, whatever the
-- update said; and a link given its hackathon here (the backfill) picks up
-- that hackathon's release, if it is known. Clients update only revoked_at
-- (DOQ-53's column grant), so only the service role reaches the other rules.
create or replace function public.mindmap_shares_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_expires timestamptz;
begin
  if old.revoked_at is not null then
    new.revoked_at := old.revoked_at;
  elsif new.revoked_at is not null then
    new.revoked_at := now();
  end if;

  if old.hackathon_slug is not null then
    new.hackathon_slug := old.hackathon_slug;
  end if;

  if old.expires_at is not null then
    new.expires_at := least(old.expires_at, coalesce(new.expires_at, old.expires_at));
  end if;

  if old.hackathon_slug is null and new.hackathon_slug is not null then
    select r.expires_at into v_expires
      from public.qdit_hackathon_releases r
     where r.hackathon_slug = new.hackathon_slug;
    if found then
      new.expires_at := least(coalesce(new.expires_at, v_expires), v_expires);
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The reads by token: expired is the same as revoked
-- ---------------------------------------------------------------------------

-- Same signature, columns and grants as DOQ-53; only the live test changes.
create or replace function public.mindmap_share(p_token text)
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
    and s.revoked_at is null
    and (s.expires_at is null or now() < s.expires_at);
$$;

create or replace function public.mindmap_share_live(p_token text)
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
       and (s.expires_at is null or now() < s.expires_at)
  );
$$;

-- POST /api/mindmap-links/status (contract v1.5.0): one row per distinct
-- well-formed token asked about, live or not. A token with no row is not in
-- the answer (the route reads it as unknown, live: false). expires_at is
-- answered only for a live link, so a revoked or expired one shows nothing
-- but live = false. At most 500 tokens, as the route allows. Service role
-- only: the route rate-limits the public before it calls this.
create function public.mindmap_share_statuses(p_tokens text[])
returns table (token text, live boolean, expires_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_tokens), 0) > 500 then
    raise exception 'at most 500 tokens' using errcode = '22023';
  end if;
  return query
    select s.token,
           s.revoked_at is null and (s.expires_at is null or now() < s.expires_at),
           case when s.revoked_at is null and (s.expires_at is null or now() < s.expires_at) then s.expires_at end
      from public.mindmap_shares s
     where s.token = any (
             select t from unnest(p_tokens) as u(t) where t ~ '^[A-Za-z0-9_-]{22,64}$'
           );
end;
$$;

revoke execute on function public.mindmap_share_statuses(text[]) from public, anon, authenticated;
grant execute on function public.mindmap_share_statuses(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- The webhook: hackathon.released
-- ---------------------------------------------------------------------------

-- The idempotency store keeps both event types. A milestone event still needs
-- its milestone; a release needs its hackathon and released_at. Rows already
-- there are all milestone events, which keep every column filled.
alter table public.qdit_webhook_events
  alter column project_id drop not null,
  alter column milestone_id drop not null,
  alter column status drop not null,
  add column hackathon_slug text check (hackathon_slug is null or hackathon_slug ~ '^[a-z0-9-]{1,64}$'),
  add column released_at    timestamptz,
  add constraint qdit_webhook_events_shape check (
    case event
      when 'hackathon.released' then hackathon_slug is not null and released_at is not null
      else project_id is not null and milestone_id is not null and status is not null
    end
  );

-- One `hackathon.released` delivery (contract section 9, v1.5.0), done in one
-- transaction: recorded by its id (a delivery already seen answers
-- 'duplicate' and changes nothing), the release kept per hackathon, and every
-- link of the hackathon given expires_at = released_at + 24 h. Never extends
-- an expiry: an event no newer (occurred_at) than the one already kept
-- changes nothing, a newer one can only bring the expiry forward, and a link
-- whose expiry is already earlier keeps it. Answers the outcome, the
-- hackathon's expiry and how many links changed.
create function public.record_qdit_hackathon_release(
  p_id             uuid,
  p_hackathon_slug text,
  p_released_at    timestamptz,
  p_occurred_at    timestamptz
)
returns table (outcome text, link_expires_at timestamptz, links_updated integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires timestamptz;
  v_n       integer;
begin
  if p_id is null or p_released_at is null or p_occurred_at is null
     or p_hackathon_slug is null or p_hackathon_slug !~ '^[a-z0-9-]{1,64}$' then
    raise exception 'A hackathon.released event needs its id, hackathon_slug, released_at and occurred_at'
      using errcode = '22023';
  end if;

  delete from public.qdit_webhook_events e
   where e.received_at < now() - interval '30 days';

  insert into public.qdit_webhook_events (id, event, hackathon_slug, released_at, occurred_at, processed_at)
  values (p_id, 'hackathon.released', p_hackathon_slug, p_released_at, p_occurred_at, now())
  on conflict (id) do nothing;
  if not found then
    update public.qdit_webhook_events e set attempts = e.attempts + 1 where e.id = p_id;
    return query
      select 'duplicate'::text,
             (select r.expires_at from public.qdit_hackathon_releases r where r.hackathon_slug = p_hackathon_slug),
             0;
    return;
  end if;

  insert into public.qdit_hackathon_releases as r (hackathon_slug, released_at, expires_at, event_id, occurred_at)
  values (p_hackathon_slug, p_released_at, p_released_at + interval '24 hours', p_id, p_occurred_at)
  on conflict (hackathon_slug) do update
     set released_at = least(r.released_at, excluded.released_at),
         expires_at  = least(r.expires_at, excluded.expires_at),
         event_id    = excluded.event_id,
         occurred_at = excluded.occurred_at,
         recorded_at = now()
   where excluded.occurred_at > r.occurred_at;

  select r.expires_at into v_expires
    from public.qdit_hackathon_releases r
   where r.hackathon_slug = p_hackathon_slug;

  update public.mindmap_shares s
     set expires_at = v_expires
   where s.hackathon_slug = p_hackathon_slug
     and (s.expires_at is null or s.expires_at > v_expires);
  get diagnostics v_n = row_count;

  return query select 'applied'::text, v_expires, v_n;
end;
$$;

comment on function public.record_qdit_hackathon_release(uuid, text, timestamptz, timestamptz) is
  'Acts on a qdit hackathon.released webhook once by id: links of that hackathon expire released_at + 24 h, never later (WP-4.7, DOQ-54).';

revoke all on function public.record_qdit_hackathon_release(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.record_qdit_hackathon_release(uuid, text, timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Rate limits for public routes
-- ---------------------------------------------------------------------------

-- Requests per fixed window, per bucket: '<scope>:<client>' (the route's hash
-- of the caller's address, never the address) and '<scope>:*' (everyone).
-- Same idea as consume_ai_quota() and the relay's quota, counted in Postgres
-- so every serverless instance sees the same count; a window is one upsert,
-- so concurrent requests cannot both slip under a limit. Rows go after an hour.
create table public.rate_limit_hits (
  bucket       text not null check (char_length(bucket) between 1 and 200),
  window_start timestamptz not null,
  hits         integer not null default 1 check (hits >= 1),
  primary key (bucket, window_start)
);

comment on table public.rate_limit_hits is
  'Fixed-window request counts for public routes, by hashed client and in total (WP-4.7, DOQ-54). Service role only.';

create index rate_limit_hits_window_idx on public.rate_limit_hits (window_start);

alter table public.rate_limit_hits enable row level security;
revoke all on table public.rate_limit_hits from public, anon, authenticated;
grant select, insert, update, delete on table public.rate_limit_hits to service_role;

-- Counts one request of p_client to p_scope in the current p_window_seconds
-- window and answers whether it is allowed: refused ('client' or 'global')
-- once this client's count passes p_client_limit or everyone's passes
-- p_global_limit, with the seconds until the window ends. Refused requests
-- count too, so hammering does not reopen the window early.
create function public.consume_rate_limit(
  p_scope          text,
  p_client         text,
  p_client_limit   integer,
  p_global_limit   integer,
  p_window_seconds integer default 60
)
returns table (allowed boolean, refused_by text, retry_after_seconds integer)
language plpgsql
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_retry  integer;
  v_all    integer;
  v_client integer;
begin
  if p_scope is null or p_scope !~ '^[a-z0-9_.-]{1,64}$'
     or p_client is null or p_client !~ '^[A-Za-z0-9_-]{1,128}$'
     or p_client_limit is null or p_client_limit < 1
     or p_global_limit is null or p_global_limit < 1
     or p_window_seconds is null or p_window_seconds not between 1 and 3600 then
    raise exception 'consume_rate_limit: bad arguments' using errcode = '22023';
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_retry := greatest(1, ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - now())))::integer);

  delete from public.rate_limit_hits h where h.window_start < now() - interval '1 hour';

  insert into public.rate_limit_hits as h (bucket, window_start) values (p_scope || ':*', v_window)
  on conflict (bucket, window_start) do update set hits = h.hits + 1
  returning h.hits into v_all;

  insert into public.rate_limit_hits as h (bucket, window_start) values (p_scope || ':' || p_client, v_window)
  on conflict (bucket, window_start) do update set hits = h.hits + 1
  returning h.hits into v_client;

  if v_client > p_client_limit then
    return query select false, 'client'::text, v_retry;
  elsif v_all > p_global_limit then
    return query select false, 'global'::text, v_retry;
  else
    return query select true, null::text, 0;
  end if;
end;
$$;

revoke all on function public.consume_rate_limit(text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, text, integer, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Backfill: links sent before this migration
-- ---------------------------------------------------------------------------

-- Nothing doqtri stores names the hackathon of a link sent before this
-- migration: the send route wrote only the token, the workspace, the sender,
-- the snapshot id (a random UUID, not derived from the hackathon), the graph
-- and the style, and its logs never carried the slug. So this migration
-- cannot fill hackathon_slug itself, and those links keep expires_at null
-- (live until revoked) until it is filled.
--
-- qdit has it: hackathon_doqtri_snapshots keeps each snapshot_id with its
-- hackathon. The operator reads the pairs there and hands them to this
-- function once, as the service role:
--
--   select public.backfill_mindmap_share_hackathons('[
--     {"snapshot_id": "…", "hackathon_slug": "…", "released_at": null}
--   ]'::jsonb);
--
-- Each entry names a link by snapshot_id. A link that already has a hackathon
-- keeps it. released_at (optional) records the hackathon's release if the
-- webhook has not, so its links expire at released_at + 24 h; the triggers
-- give a backfilled link the expiry of a release already known. Answers how
-- many links were given their hackathon. Safe to run again.
create function public.backfill_mindmap_share_hackathons(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'backfill_mindmap_share_hackathons: expects a JSON array' using errcode = '22023';
  end if;

  insert into public.qdit_hackathon_releases as r (hackathon_slug, released_at, expires_at, occurred_at)
  select distinct on (x.hackathon_slug)
         x.hackathon_slug, x.released_at, x.released_at + interval '24 hours', x.released_at
    from jsonb_to_recordset(p_rows) as x(snapshot_id uuid, hackathon_slug text, released_at timestamptz)
   where x.released_at is not null and x.hackathon_slug ~ '^[a-z0-9-]{1,64}$'
   order by x.hackathon_slug, x.released_at
  on conflict (hackathon_slug) do update
     set released_at = least(r.released_at, excluded.released_at),
         expires_at  = least(r.expires_at, excluded.expires_at);

  update public.mindmap_shares s
     set hackathon_slug = x.hackathon_slug
    from jsonb_to_recordset(p_rows) as x(snapshot_id uuid, hackathon_slug text, released_at timestamptz)
   where s.snapshot_id = x.snapshot_id
     and s.hackathon_slug is null
     and x.hackathon_slug ~ '^[a-z0-9-]{1,64}$';
  get diagnostics v_n = row_count;

  -- A release recorded above also reaches links that already had a hackathon.
  update public.mindmap_shares s
     set expires_at = r.expires_at
    from public.qdit_hackathon_releases r
   where s.hackathon_slug = r.hackathon_slug
     and (s.expires_at is null or s.expires_at > r.expires_at);

  return v_n;
end;
$$;

comment on function public.backfill_mindmap_share_hackathons(jsonb) is
  'Operator backfill: names the hackathon of mindmap links sent before DOQ-54, from qdit''s snapshot_id pairs (WP-4.7).';

revoke all on function public.backfill_mindmap_share_hackathons(jsonb) from public, anon, authenticated;
grant execute on function public.backfill_mindmap_share_hackathons(jsonb) to service_role;
