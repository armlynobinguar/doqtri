-- pgTAP tests for 20261025090000_chain_jobs_scheduler.sql (WP-1.9): the
-- pg_cron job that calls GET /api/chain/jobs every minute through pg_net,
-- with the URL and the CRON_SECRET bearer read from Vault at run time, and
-- the health signal that says when it cannot.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/chain_jobs_scheduler.test.sql
--
-- Needs pg_cron, pg_net and Vault: a Supabase branch or `supabase test db`
-- has them; the PGlite harness stands them in with --stub-scheduler. Where
-- they are missing the migration skips the job (with a WARNING) and this
-- file cannot run. pgTAP cannot see a WARNING either; the harness prints
-- them with --notices: the migration's, and request_chain_jobs_run()'s on
-- the runs below that have a secret missing.
--
-- One transaction, rolled back, so the secrets stored here never outlive
-- it, and pg_net sends nothing (it only starts requests after a commit).

begin;
create extension if not exists pgtap with schema extensions;

select plan(15);

-- Runs the job's command as pg_cron would and returns how many requests it
-- queued.
create function pg_temp.run_job() returns bigint
language plpgsql as $$
declare
  v_before  bigint;
  v_command text;
begin
  select count(*) into v_before from net.http_request_queue;
  select j.command into v_command from cron.job j where j.jobname = 'doqtri-chain-jobs';
  execute v_command;
  return (select count(*) from net.http_request_queue) - v_before;
end;
$$;


-- ---------------------------------------------------------------------------
-- The job
-- ---------------------------------------------------------------------------

select results_eq(
  $$ select schedule from cron.job where jobname = 'doqtri-chain-jobs' $$,
  $$ values ('* * * * *'::text) $$,
  'one job, every minute');
select is(
  (select command from cron.job where jobname = 'doqtri-chain-jobs'),
  'select public.request_chain_jobs_run()',
  'the job holds no secret; it runs request_chain_jobs_run(), which reads them from Vault');


-- ---------------------------------------------------------------------------
-- What it sends, and the health signal
-- ---------------------------------------------------------------------------

-- Whatever this environment already stores is set aside for the test.
delete from vault.secrets where name in ('doqtri_chain_jobs_url', 'doqtri_cron_secret');

select is(pg_temp.run_job(), 0::bigint, 'with no secrets stored the job sends nothing');
select is(
  public.chain_jobs_scheduler_health(),
  '{"status": "missing", "job": true, "missing_secrets": ["doqtri_chain_jobs_url", "doqtri_cron_secret"]}'::jsonb,
  'health: missing, naming both secrets');

select vault.create_secret('https://doqtri.test/api/chain/jobs', 'doqtri_chain_jobs_url');
select vault.create_secret('', 'doqtri_cron_secret');
select is(pg_temp.run_job(), 0::bigint, 'nor with the URL and an empty bearer');
select is(
  public.chain_jobs_scheduler_health(),
  '{"status": "missing", "job": true, "missing_secrets": ["doqtri_cron_secret"]}'::jsonb,
  'health: missing, naming the bearer only (an empty secret is not stored)');

update vault.secrets set secret = 'cron-secret-for-tests' where name = 'doqtri_cron_secret';
select pg_temp.run_job();
select results_eq(
  $$ select method, url, headers ->> 'Authorization', timeout_milliseconds
       from net.http_request_queue order by id desc limit 1 $$,
  $$ values ('GET'::text, 'https://doqtri.test/api/chain/jobs'::text,
             'Bearer cron-secret-for-tests'::text, 60000) $$,
  'with both, one GET to the route with the CRON_SECRET bearer');
select is(
  public.chain_jobs_scheduler_health(),
  '{"status": "configured", "job": true, "missing_secrets": []}'::jsonb,
  'health: configured');
select ok(
  public.chain_jobs_scheduler_health()::text not like '%cron-secret-for-tests%'
  and public.chain_jobs_scheduler_health()::text not like '%doqtri.test%',
  'health names secrets, never their values');

update cron.job set active = false where jobname = 'doqtri-chain-jobs';
select is(
  public.chain_jobs_scheduler_health(),
  '{"status": "missing", "job": false, "missing_secrets": []}'::jsonb,
  'health: missing when the job is not active, even with both secrets');
update cron.job set active = true where jobname = 'doqtri-chain-jobs';

delete from cron.job where jobname = 'doqtri-chain-jobs';
select is(
  public.chain_jobs_scheduler_health() ->> 'status', 'missing',
  'health: missing when the job was unscheduled');


-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'public.chain_jobs_scheduler_health()', 'execute')
  and not has_function_privilege('anon', 'public.chain_jobs_scheduler_health()', 'execute'),
  'health: not callable by a client');
select ok(
  has_function_privilege('service_role', 'public.chain_jobs_scheduler_health()', 'execute'),
  'health: callable by service_role, for the cron and admin routes');
select ok(
  not has_function_privilege('authenticated', 'public.request_chain_jobs_run()', 'execute')
  and not has_function_privilege('anon', 'public.request_chain_jobs_run()', 'execute')
  and not has_function_privilege('service_role', 'public.request_chain_jobs_run()', 'execute')
  and not has_function_privilege('authenticated', 'public.chain_jobs_scheduler_missing_secrets()', 'execute')
  and not has_function_privilege('anon', 'public.chain_jobs_scheduler_missing_secrets()', 'execute')
  and not has_function_privilege('service_role', 'public.chain_jobs_scheduler_missing_secrets()', 'execute'),
  'the job function and the Vault helper are callable by no API role');
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('chain_jobs_scheduler_health', 'request_chain_jobs_run',
                        'chain_jobs_scheduler_missing_secrets')),
  'the three functions are SECURITY DEFINER with search_path pinned');

select * from finish();
rollback;
