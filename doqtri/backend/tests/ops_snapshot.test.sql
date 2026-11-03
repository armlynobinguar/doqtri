-- pgTAP tests for 20261103100000_ops_snapshot.sql (DOQ-14, WP-4.3): the one
-- read behind /admin/ops. Only the service role may call it; it answers
-- counts, ages and sizes in a fixed shape, and the pg_cron, pg_net and
-- storage parts answer null where those are missing rather than failing.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/ops_snapshot.test.sql
--
-- The PGlite harness runs it with --stub-scheduler (pg_cron's cron.job, pg_net
-- and Vault stand-ins). cron.job_run_details, net._http_response and
-- storage.objects.metadata are added below, inside the transaction, to cover
-- the paths hosted Supabase takes. One transaction, rolled back: now() is
-- fixed, so ages are made by back-dating rows.

begin;
create extension if not exists pgtap with schema extensions;

select plan(31);


-- ---------------------------------------------------------------------------
-- Who may call it
-- ---------------------------------------------------------------------------

select is(
  (select p.prosecdef from pg_proc p where p.oid = 'public.ops_snapshot(interval, interval)'::regprocedure),
  true, 'ops_snapshot() is SECURITY DEFINER');
select is(
  (select p.proconfig from pg_proc p where p.oid = 'public.ops_snapshot(interval, interval)'::regprocedure),
  array['search_path=""'], 'with an empty search_path');
select ok(
  not has_function_privilege('anon', 'public.ops_snapshot(interval, interval)', 'execute'),
  'anon cannot call it');
select ok(
  not has_function_privilege('authenticated', 'public.ops_snapshot(interval, interval)', 'execute'),
  'a signed-in user cannot call it');
select ok(
  has_function_privilege('service_role', 'public.ops_snapshot(interval, interval)', 'execute'),
  'the service role can');


-- ---------------------------------------------------------------------------
-- An empty database: every part is there, every count is zero
-- ---------------------------------------------------------------------------

create temp table s0 as select public.ops_snapshot() as v;

select is(
  (select array_agg(k order by k) from s0, jsonb_object_keys(s0.v) k),
  array['ai_usage_24h', 'at', 'chain_jobs', 'chain_usage_24h', 'chain_writes', 'cron', 'doc_locks',
        'ingests', 'moderation', 'qdit', 'relay_channels', 'scheduler', 'storage', 'wallet_topups'],
  'the snapshot has every part the dashboard reads');
select is((select v -> 'chain_jobs' from s0),
  '{"pending": 0, "needs_product_owner": 0, "failed": 0, "failed_24h": 0, "oldest_pending_at": null}'::jsonb,
  'no chain jobs: zeros and no oldest pending');
select is((select v -> 'relay_channels' from s0), '[]'::jsonb, 'no channels: an empty list');
select is((select v -> 'ai_usage_24h' from s0),
  '{"total": 0, "by_route": {}, "top_user": 0}'::jsonb, 'no AI calls: zeros');
select is((select v -> 'qdit' from s0),
  '{"connections": {}, "webhooks_late": 0}'::jsonb, 'no qdit connections or events');
select is((select v #> '{storage,buckets}' from s0), 'null'::jsonb,
  'storage.objects without metadata: buckets answer null');
select ok((select (v #>> '{storage,db_bytes}')::bigint > 0 from s0), 'the database size is reported');
select ok(
  (select count(*) = 3 from pg_indexes
    where schemaname = 'public'
      and indexname in ('chain_usage_created_idx', 'ai_usage_created_idx', 'ingests_created_idx')),
  'the 24 hour windows have created_at indexes');
select is((select v -> 'cron' from s0),
  '{"last_run": null, "last_http": null}'::jsonb,
  'no cron.job_run_details or net._http_response: both null');


-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000014a1', 'ops-a@example.com', now()),
  ('00000000-0000-4000-8000-0000000014a2', 'ops-b@example.com', now());

insert into public.workspaces (id, name, slug, created_by) values
  ('14000000-0000-4000-8000-000000000001', 'Ops', 'ops-doq14', '00000000-0000-4000-8000-0000000014a1');
insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('14000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000014a1',
   '14000000-0000-4000-8000-000000000001', 'Ops note', '# Ops note'),
  ('14000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000014a1',
   '14000000-0000-4000-8000-000000000001', 'Ops note 2', '# Ops note 2');

-- Chain jobs: two pending (the older one an hour old), one failed.
insert into public.workspace_chain_jobs (workspace_id, kind, address, network, status, created_at) values
  ('14000000-0000-4000-8000-000000000001', 'revoke', 'G' || repeat('D', 55), 'testnet', 'pending', now() - interval '1 hour'),
  ('14000000-0000-4000-8000-000000000001', 'revoke', 'G' || repeat('E', 55), 'testnet', 'pending', now() - interval '1 minute'),
  ('14000000-0000-4000-8000-000000000001', 'revoke', 'G' || repeat('F', 55), 'testnet', 'failed',  now() - interval '2 days'),
  ('14000000-0000-4000-8000-000000000001', 'revoke', 'G' || repeat('G', 55), 'testnet', 'failed',  now() - interval '3 days');
-- The update trigger stamps updated_at; the second failure is two days old.
alter table public.workspace_chain_jobs disable trigger user;
update public.workspace_chain_jobs set updated_at = now() - interval '2 days'
 where address = 'G' || repeat('G', 55);
alter table public.workspace_chain_jobs enable trigger user;

-- Wallet top-ups: one pending, two failed (retry cap reached; one of them
-- two days ago), one done.
insert into public.wallet_topups (user_id, address, status, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000014a1', 'C' || repeat('A', 55), 'pending', now() - interval '10 minutes', now()),
  ('00000000-0000-4000-8000-0000000014a2', 'C' || repeat('B', 55), 'failed',  now() - interval '1 day', now()),
  ('00000000-0000-4000-8000-0000000014a2', 'C' || repeat('D', 55), 'failed',  now() - interval '3 days', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000014a2', 'C' || repeat('C', 55), 'done',    now() - interval '1 day', now());

-- Chain writes: one pending, one failed today, one failed two days ago, one confirmed.
insert into public.chain_writes (network, tx_hash, document_id, fn, owner, status, created_at) values
  ('testnet', repeat('a', 64), '14000000-0000-4000-8000-0000000000d1', 'register_document', 'C' || repeat('A', 55), 'pending',   now() - interval '3 minutes'),
  ('testnet', repeat('b', 64), '14000000-0000-4000-8000-0000000000d1', 'update_document',   'C' || repeat('A', 55), 'failed',    now() - interval '1 hour'),
  ('testnet', repeat('c', 64), '14000000-0000-4000-8000-0000000000d1', 'update_document',   'C' || repeat('A', 55), 'failed',    now() - interval '2 days'),
  ('testnet', repeat('d', 64), '14000000-0000-4000-8000-0000000000d2', 'register_document', 'C' || repeat('A', 55), 'confirmed', now());

-- Relay channels: three on testnet, one leased now and one whose lease ran out.
insert into public.relay_channels (idx, network, public_key, leased_until, lease_id) values
  (0, 'testnet', 'G' || repeat('A', 55), now() + interval '30 seconds', gen_random_uuid()),
  (1, 'testnet', 'G' || repeat('B', 55), now() - interval '30 seconds', gen_random_uuid()),
  (2, 'testnet', 'G' || repeat('C', 55), null, null);

-- Chain quota use: two writes and a deploy today, one write yesterday-but-older.
insert into public.chain_usage (user_id, network, kind, created_at) values
  ('00000000-0000-4000-8000-0000000014a1', 'testnet', 'write',  now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000000014a2', 'testnet', 'write',  now() - interval '2 hours'),
  ('00000000-0000-4000-8000-0000000014a1', 'testnet', 'deploy', now() - interval '3 hours'),
  ('00000000-0000-4000-8000-0000000014a1', 'testnet', 'write',  now() - interval '25 hours');

-- AI use today: user a three times, user b once; one older call.
insert into public.ai_usage (user_id, route, created_at) values
  ('00000000-0000-4000-8000-0000000014a1', 'ingest',     now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000000014a1', 'ingest',     now() - interval '2 hours'),
  ('00000000-0000-4000-8000-0000000014a1', 'mindmap',    now() - interval '3 hours'),
  ('00000000-0000-4000-8000-0000000014a2', 'regenerate', now() - interval '4 hours'),
  ('00000000-0000-4000-8000-0000000014a2', 'ingest',     now() - interval '30 hours');

-- Ingests: one failed today, one pending for ten minutes (stuck), one pending
-- for a minute (still running), one succeeded.
insert into public.ingests (user_id, object_path, filename, kind, status, created_at) values
  ('00000000-0000-4000-8000-0000000014a1', 'a/1', '1.pdf', 'pdf', 'failed',    now() - interval '1 hour'),
  ('00000000-0000-4000-8000-0000000014a1', 'a/2', '2.pdf', 'pdf', 'pending',   now() - interval '10 minutes'),
  ('00000000-0000-4000-8000-0000000014a1', 'a/3', '3.pdf', 'pdf', 'pending',   now() - interval '1 minute'),
  ('00000000-0000-4000-8000-0000000014a1', 'a/4', '4.pdf', 'pdf', 'succeeded', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-0000000014a1', 'a/5', '5.pdf', 'pdf', 'pending',   now() - interval '3 days');

-- qdit: a webhook event unprocessed for ten minutes, one received just now,
-- one processed.
insert into public.qdit_webhook_events (id, event, project_id, milestone_id, status, occurred_at, received_at, processed_at) values
  (gen_random_uuid(), 'milestone.status_changed', gen_random_uuid(), gen_random_uuid(), 'approved', now(), now() - interval '10 minutes', null),
  (gen_random_uuid(), 'milestone.status_changed', gen_random_uuid(), gen_random_uuid(), 'approved', now(), now(), null),
  (gen_random_uuid(), 'milestone.status_changed', gen_random_uuid(), gen_random_uuid(), 'approved', now(), now() - interval '1 hour', now()),
  (gen_random_uuid(), 'milestone.status_changed', gen_random_uuid(), gen_random_uuid(), 'approved', now(), now() - interval '3 days', null);

-- Promo: one pending entry with a rating error, one shortlisted.
insert into public.promo_submissions (user_id, promo, image_paths, status, ai_rating_error) values
  ('00000000-0000-4000-8000-0000000014a1', 'launch', array['a.png'], 'pending', 'model timeout'),
  ('00000000-0000-4000-8000-0000000014a2', 'launch', array['b.png'], 'shortlisted', null);

-- Locks: one fresh, one past the idle timeout.
insert into public.doc_locks (document_id, holder, session_id, heartbeat_at) values
  ('14000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000014a1', gen_random_uuid(), now()),
  ('14000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000014a1', gen_random_uuid(),
   now() - public.doc_lock_idle_timeout() - interval '1 minute');

-- Hosted Supabase's object sizes, pg_cron's run log and pg_net's responses.
alter table storage.objects add column metadata jsonb;
insert into storage.objects (bucket_id, name, metadata) values
  ('uploads', 'a/1', '{"size": 1000}'),
  ('uploads', 'a/2', '{"size": 500}'),
  ('promo-submissions', 'b/1', '{"size": 42}');

create table cron.job_run_details (
  jobid bigint, runid bigserial primary key, status text, return_message text,
  start_time timestamptz, end_time timestamptz);
insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
select j.jobid, x.status, x.msg, x.t, x.t + interval '1 second'
  from cron.job j,
       (values ('succeeded', '1 row', now() - interval '2 minutes'),
               ('failed', repeat('x', 300), now() - interval '1 minute')) as x(status, msg, t)
 where j.jobname = 'doqtri-chain-jobs';

create table net._http_response (
  id bigserial primary key, status_code integer, content text, timed_out boolean,
  error_msg text, created timestamptz);
insert into net._http_response (status_code, content, timed_out, error_msg, created) values
  (200, 'old body', false, null, now() - interval '2 minutes'),
  (401, '{"error":"Unauthorized"}', false, null, now() - interval '1 minute');

create temp table s1 as select public.ops_snapshot() as v;


-- ---------------------------------------------------------------------------
-- What it counts
-- ---------------------------------------------------------------------------

select is((select v -> 'chain_jobs' from s1),
  jsonb_build_object('pending', 2, 'needs_product_owner', 0, 'failed', 2, 'failed_24h', 1,
                     'oldest_pending_at', now() - interval '1 hour'),
  'chain jobs by status, with the oldest pending one; failed_24h counts only recent failures');
select is((select v -> 'wallet_topups' from s1),
  jsonb_build_object('pending', 1, 'failed', 2, 'failed_24h', 1, 'oldest_pending_at', now() - interval '10 minutes'),
  'wallet top-ups: done rows are not counted; failed_24h only recent ones');
select is((select v -> 'chain_writes' from s1),
  jsonb_build_object('pending', 1, 'oldest_pending_at', now() - interval '3 minutes', 'failed_24h', 1),
  'chain writes: failures older than 24 h are left out');
select is((select v -> 'relay_channels' from s1),
  '[{"network": "testnet", "total": 3, "leased": 1}]'::jsonb,
  'a lease that ran out does not count as leased');
select is((select v -> 'chain_usage_24h' from s1),
  '[{"network": "testnet", "kind": "deploy", "count": 1}, {"network": "testnet", "kind": "write", "count": 2}]'::jsonb,
  'chain quota use over the last 24 h, by kind');
select is((select v -> 'ai_usage_24h' from s1),
  '{"total": 4, "by_route": {"ingest": 2, "mindmap": 1, "regenerate": 1}, "top_user": 3}'::jsonb,
  'AI calls over 24 h by route, and the heaviest user''s count');
select is((select v -> 'ingests' from s1),
  '{"total_24h": 4, "failed_24h": 1, "stuck_pending": 1}'::jsonb,
  'an ingest pending past 280 s is stuck; one a minute old is not, nor one abandoned days ago');
select is((select (v #>> '{ingests,stuck_pending}')::int
             from (select public.ops_snapshot(interval '30 seconds') as v) x), 2,
  'the stuck threshold is a parameter');
select is((select v #> '{qdit,webhooks_late}' from s1), '1'::jsonb,
  'a webhook event unprocessed after 5 minutes is late; one just received is not, nor one from days ago');
select is((select v -> 'moderation' from s1),
  '{"templates_pending": 0, "reports_open": 0, "promo_pending": 1, "promo_rating_errors": 1}'::jsonb,
  'the moderation backlog');
select is((select v -> 'doc_locks' from s1),
  '{"active": 1, "stale": 1}'::jsonb,
  'a lock past the idle timeout is stale');
select is((select v #> '{storage,buckets}' from s1),
  '{"uploads": 1500, "promo-submissions": 42}'::jsonb,
  'bytes per bucket from storage.objects.metadata');


-- ---------------------------------------------------------------------------
-- The scheduler's own record
-- ---------------------------------------------------------------------------

select is((select v #>> '{cron,last_run,status}' from s1), 'failed', 'the latest pg_cron run');
select is((select char_length(v #>> '{cron,last_run,message}') from s1), 200,
  'its message is cut to 200 characters');
select is((select v #> '{cron,last_http,status_code}' from s1), '401'::jsonb,
  'the latest pg_net response status');
select ok((select not (v #> '{cron,last_http}') ? 'content' from s1),
  'the response body is never returned');
select is((select v #>> '{scheduler,status}' from s1),
  (select public.chain_jobs_scheduler_health() ->> 'status'),
  'scheduler health is chain_jobs_scheduler_health()');

select * from finish();
rollback;
