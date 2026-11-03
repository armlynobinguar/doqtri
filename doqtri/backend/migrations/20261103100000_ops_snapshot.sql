-- The ops dashboard's database read (DOQ-14, WP-4.3).
--
-- /admin/ops (doqtri/frontend/app/admin/ops) shows doqtri staff what can run
-- out, what is queued, and whether the scheduled runs happen. Everything it
-- needs from the database comes from this one call, so the page costs one
-- round trip and the dashboard never needs table grants of its own.
--
-- * Counts, ages and sizes only: no user id, wallet, document, token, error
--   text from a user's row, or secret. The pg_cron and pg_net details are
--   the scheduler's own (status, times, HTTP status), with messages cut to
--   200 characters.
--
-- * The cron and net schemas are not exposed to PostgREST, which is why the
--   last pg_cron run and the last pg_net response are read here. Both are
--   guarded: a database without pg_cron or pg_net (plain Postgres, the PGlite
--   test harness) answers null for them, and never fails.
--
-- * Storage sizes come from storage.objects.metadata->>'size', which hosted
--   Supabase fills in; where that column is missing the buckets answer null.
--
-- * Failed chain jobs and wallet top-ups are kept as the record, so each
--   answers both its total and failed_24h (by updated_at, when it failed):
--   the dashboard warns on the recent ones only.
--
-- * Stuck ingests and late webhooks count only rows from the last 24 hours,
--   so one that was abandoned long ago does not keep the dashboard red for
--   weeks (webhook events are kept for 30 days).
--
-- * chain_writes has no updated_at: a write fails within its 60 s time
--   bound, so its created_at stands in for when it failed.
--
-- * Three indexes on created_at serve the 24 hour windows; the tables had
--   only per-user indexes, so the global windows scanned them whole.
--
-- * The two age limits are parameters so tests can move them; the server
--   passes nothing and gets the defaults, which match the app:
--     p_ingest_stuck_after  280 s, the ingest pipeline's total budget
--                           (lib/ingest/pipeline.ts)
--     p_webhook_late_after  5 minutes for a qdit webhook event not processed
--
-- * SECURITY DEFINER with an empty search_path, executable by service_role
--   only, like chain_jobs_scheduler_health().

create index if not exists chain_usage_created_idx on public.chain_usage (created_at);
create index if not exists ai_usage_created_idx on public.ai_usage (created_at);
create index if not exists ingests_created_idx on public.ingests (created_at);

create or replace function public.ops_snapshot(
  p_ingest_stuck_after  interval default interval '280 seconds',
  p_webhook_late_after  interval default interval '5 minutes'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_buckets   jsonb := null;
  v_last_run  jsonb := null;
  v_last_http jsonb := null;
begin
  -- Storage: bytes per bucket, where hosted Supabase records object sizes.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'storage' and table_name = 'objects' and column_name = 'metadata'
  ) then
    execute $q$
      select coalesce(jsonb_object_agg(b.bucket_id, b.bytes), '{}'::jsonb)
        from (select o.bucket_id, sum(coalesce((o.metadata ->> 'size')::bigint, 0)) as bytes
                from storage.objects o
               group by o.bucket_id) b
    $q$ into v_buckets;
  end if;

  -- The last run of the doqtri-chain-jobs pg_cron job.
  if to_regclass('cron.job_run_details') is not null and to_regclass('cron.job') is not null then
    execute $q$
      select jsonb_build_object(
               'status', d.status,
               'start_time', d.start_time,
               'end_time', d.end_time,
               'message', left(d.return_message, 200))
        from cron.job_run_details d
        join cron.job j on j.jobid = d.jobid
       where j.jobname = 'doqtri-chain-jobs'
       order by d.start_time desc nulls last
       limit 1
    $q$ into v_last_run;
  end if;

  -- The last HTTP response pg_net recorded: the job is the only caller here.
  if to_regclass('net._http_response') is not null then
    execute $q$
      select jsonb_build_object(
               'status_code', r.status_code,
               'timed_out', r.timed_out,
               'error', left(r.error_msg, 200),
               'created', r.created)
        from net._http_response r
       order by r.created desc nulls last
       limit 1
    $q$ into v_last_http;
  end if;

  return jsonb_build_object(
    'at', now(),

    'chain_jobs', (
      select jsonb_build_object(
               'pending',             count(*) filter (where j.status = 'pending'),
               'needs_product_owner', count(*) filter (where j.status = 'needs_product_owner'),
               'failed',              count(*) filter (where j.status = 'failed'),
               'failed_24h',          count(*) filter (where j.status = 'failed'
                                                         and j.updated_at > now() - interval '24 hours'),
               'oldest_pending_at',   min(j.created_at) filter (where j.status = 'pending'))
        from public.workspace_chain_jobs j),

    'wallet_topups', (
      select jsonb_build_object(
               'pending',           count(*) filter (where t.status = 'pending'),
               'failed',            count(*) filter (where t.status = 'failed'),
               'failed_24h',        count(*) filter (where t.status = 'failed'
                                                       and t.updated_at > now() - interval '24 hours'),
               'oldest_pending_at', min(t.created_at) filter (where t.status = 'pending'))
        from public.wallet_topups t),

    'chain_writes', (
      select jsonb_build_object(
               'pending',           count(*) filter (where w.status = 'pending'),
               'oldest_pending_at', min(w.created_at) filter (where w.status = 'pending'),
               'failed_24h',        count(*) filter (where w.status = 'failed'
                                                       and w.created_at > now() - interval '24 hours'))
        from public.chain_writes w),

    'relay_channels', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'network', c.network, 'total', c.total, 'leased', c.leased) order by c.network), '[]'::jsonb)
        from (select r.network,
                     count(*) as total,
                     count(*) filter (where r.leased_until > now()) as leased
                from public.relay_channels r
               group by r.network) c),

    'chain_usage_24h', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'network', u.network, 'kind', u.kind, 'count', u.n) order by u.network, u.kind), '[]'::jsonb)
        from (select c.network, c.kind, count(*) as n
                from public.chain_usage c
               where c.created_at > now() - interval '24 hours'
               group by c.network, c.kind) u),

    'ai_usage_24h', (
      select jsonb_build_object(
               'total', coalesce(sum(r.n), 0),
               'by_route', coalesce(jsonb_object_agg(r.route, r.n), '{}'::jsonb),
               'top_user', coalesce((
                 select max(p.n) from (
                   select count(*) as n from public.ai_usage a
                    where a.created_at > now() - interval '24 hours'
                    group by a.user_id) p), 0))
        from (select a.route, count(*) as n
                from public.ai_usage a
               where a.created_at > now() - interval '24 hours'
               group by a.route) r),

    'ingests', (
      select jsonb_build_object(
               'total_24h',     count(*) filter (where i.created_at > now() - interval '24 hours'),
               'failed_24h',    count(*) filter (where i.status = 'failed'
                                                   and i.created_at > now() - interval '24 hours'),
               'stuck_pending', count(*) filter (where i.status = 'pending'
                                                   and i.created_at < now() - p_ingest_stuck_after
                                                   and i.created_at > now() - interval '24 hours'))
        from public.ingests i),

    'qdit', jsonb_build_object(
      'connections', (
        select coalesce(jsonb_object_agg(c.status, c.n), '{}'::jsonb)
          from (select ic.status, count(*) as n
                  from public.integration_connections ic
                 group by ic.status) c),
      'webhooks_late', (
        select count(*) from public.qdit_webhook_events e
         where e.processed_at is null
           and e.received_at < now() - p_webhook_late_after
           and e.received_at > now() - interval '24 hours')),

    'moderation', jsonb_build_object(
      'templates_pending',  (select count(*) from public.market_templates m where m.status = 'pending'),
      'reports_open',       (select count(*) from public.market_reports r where r.status = 'open'),
      'promo_pending',      (select count(*) from public.promo_submissions p where p.status = 'pending'),
      'promo_rating_errors',(select count(*) from public.promo_submissions p where p.ai_rating_error is not null)),

    'doc_locks', (
      select jsonb_build_object(
               'active', count(*) filter (where l.heartbeat_at >= now() - public.doc_lock_idle_timeout()),
               'stale',  count(*) filter (where l.heartbeat_at <  now() - public.doc_lock_idle_timeout()))
        from public.doc_locks l),

    'storage', jsonb_build_object(
      'db_bytes', pg_catalog.pg_database_size(pg_catalog.current_database()),
      'buckets', v_buckets),

    'scheduler', public.chain_jobs_scheduler_health(),

    'cron', jsonb_build_object('last_run', v_last_run, 'last_http', v_last_http)
  );
end;
$$;

comment on function public.ops_snapshot(interval, interval) is
  'SECURITY DEFINER, service_role only. The /admin/ops snapshot (DOQ-14): queue counts and ages, 24 h quota use, moderation backlog, lock, storage and database sizes, scheduler health and the last pg_cron run and pg_net response. Counts and times only, never user data or secrets.';

revoke all on function public.ops_snapshot(interval, interval) from public, anon, authenticated;
grant execute on function public.ops_snapshot(interval, interval) to service_role;
