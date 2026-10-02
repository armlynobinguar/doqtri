-- Per-user daily budget for the routes that call OpenAI.
--
-- Sign-in only needs a Stellar keypair, which anyone can generate for free, so
-- without a cap a single account could loop /api/ingest, /api/ingest/retry,
-- /api/regenerate or /api/mindmap and spend the project's OpenAI credit.
--
-- One row per accepted AI request. The check and the insert happen in one
-- function under a per-user advisory lock, so two concurrent requests cannot
-- both slip under the limit.
--
-- The browser may read its own rows (e.g. to show remaining usage). Writes go
-- through consume_ai_quota() with the service role only.

create table public.ai_usage (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  route      text not null,
  created_at timestamptz not null default now()
);

alter table public.ai_usage enable row level security;

create policy "own ai usage - select" on public.ai_usage
  for select using (auth.uid() = user_id);

create index ai_usage_user_created_idx
  on public.ai_usage (user_id, created_at desc);

-- Records one AI request for p_user_id if they are under p_limit requests in
-- the trailing p_window. Returns whether it was allowed, how many requests are
-- counted in the window, and (when refused) how many seconds until a slot frees.
create function public.consume_ai_quota(
  p_user_id uuid,
  p_route   text,
  p_limit   integer,
  p_window  interval default interval '24 hours'
)
returns table (allowed boolean, used integer, retry_after_seconds integer)
language plpgsql
set search_path = ''
as $$
declare
  v_used   integer;
  v_freed  timestamptz;
begin
  -- Serialize per user; other users are not blocked.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select count(*)::integer into v_used
    from public.ai_usage
   where user_id = p_user_id
     and created_at > now() - p_window;

  if v_used >= p_limit then
    -- The window frees a slot when the row that pushed the count to the limit
    -- ages out: the (v_used - p_limit + 1)-th oldest row in the window.
    select u.created_at + p_window into v_freed
      from public.ai_usage u
     where u.user_id = p_user_id
       and u.created_at > now() - p_window
     order by u.created_at asc
    offset (v_used - p_limit)
     limit 1;

    return query select
      false,
      v_used,
      greatest(1, ceil(extract(epoch from (v_freed - now())))::integer);
    return;
  end if;

  insert into public.ai_usage (user_id, route) values (p_user_id, p_route);
  return query select true, v_used + 1, 0;
end;
$$;

-- p_user_id is a parameter, so a signed-in user calling this over RPC could
-- spend someone else's budget. Only the service role (the API routes) may call it.
revoke execute on function public.consume_ai_quota(uuid, text, integer, interval)
  from public, anon, authenticated;
grant execute on function public.consume_ai_quota(uuid, text, integer, interval)
  to service_role;
