-- The on-chain follow-up queue runs every minute (WP-1.9).
--
-- workspace_chain_jobs (20261024150500_workspace_members_management.sql)
-- holds the revocations and handovers the server owes the chain. The app
-- works them at once after a removal, and GET /api/chain/jobs retries what
-- is left, but nothing called that route: a removal whose first send failed
-- was retried only when someone next opened the members screen, so a
-- removed Freighter editor could keep writing on-chain until then (the
-- database and relay already refuse them, D-16). This is the scheduler,
-- built like qdit's webhook delivery job (qdit
-- supabase/migrations/20261024130000_integration_webhooks.sql section 8, and
-- 20261025090000_integration_hardening.sql section 2):
--
-- * pg_cron runs `doqtri-chain-jobs` every minute. It calls
--   request_chain_jobs_run(), which GETs the route through pg_net with the
--   URL and the CRON_SECRET bearer read from Supabase Vault at each run, so
--   neither is in this file, in cron.job, or in a log of it. Vercel Cron
--   cannot do this on a Hobby plan (at most once a day, production only),
--   and nothing records which plan doqtri is on; doqtri/frontend/vercel.json
--   therefore runs the route once a day as a backstop. Two callers are
--   harmless: claim_workspace_chain_jobs() leases each job for two minutes,
--   and every job is idempotent on-chain.
--
-- * Until an operator stores both secrets the job sends nothing, and says
--   so: request_chain_jobs_run() RAISEs a WARNING naming the missing ones on
--   every run, so pg_cron's run log and the Postgres log show it, rather
--   than a run that succeeds with nothing done. The secrets are stored once
--   per environment, in the SQL editor:
--
--     select vault.create_secret('https://<doqtri host>/api/chain/jobs',
--                                'doqtri_chain_jobs_url');
--     select vault.create_secret('<the CRON_SECRET the app has>', 'doqtri_cron_secret');
--
--   (vault.update_secret() changes one later.) The URL is a production
--   deployment's: preview deployments are not reachable this way, and with
--   NEXT_PUBLIC_REGISTRY_EDITORS unset the route does nothing anyway.
--
-- * chain_jobs_scheduler_health() answers `configured`, `missing` (the job
--   is not scheduled or not active, or a secret is not stored, by name) or
--   `unavailable` (no pg_cron, pg_net or Vault in this database), for the
--   service role only. GET /api/chain/jobs returns it with every run and
--   logs a warning when it is not `configured`, and GET
--   /api/admin/chain-jobs shows it to doqtri staff (DOQTRI_ADMINS) with the
--   queue's counts. Names only, never secret values.
--
-- * This migration RAISEs a WARNING when it cannot schedule the job (no
--   pg_cron, pg_net or Vault: plain Postgres and the PGlite test harness)
--   and when it schedules it but the secrets are not stored yet (every
--   fresh environment). It never fails for either: the daily Vercel run
--   and the members screen still work the queue.
--
-- The functions read Vault as their owner and none is callable by a client.
-- The whole file is safe to run again (create or replace, idempotent
-- grants, cron.schedule replacing a job of the same name), which is how an
-- operator schedules the job after enabling pg_cron and pg_net later.
-- See doqtri/docs/runbooks/registry-editors-rollout.md for the rollout.


-- ---------------------------------------------------------------------------
-- The scheduler's functions
-- ---------------------------------------------------------------------------

-- The Vault secrets the job needs that are not stored, by name, in a fixed
-- order. Empty when both are. Assumes Vault exists; callers check. PL/pgSQL
-- rather than SQL so it can be created where Vault is absent: a SQL
-- function's body is checked against the catalog when it is created.
create or replace function public.chain_jobs_scheduler_missing_secrets()
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return (
    select coalesce(array_agg(n.name order by n.ord), '{}')
      from (values (1, 'doqtri_chain_jobs_url'), (2, 'doqtri_cron_secret')) as n (ord, name)
     where not exists (
       select 1 from vault.decrypted_secrets d
        where d.name = n.name
          and nullif(d.decrypted_secret, '') is not null
     )
  );
end;
$$;

comment on function public.chain_jobs_scheduler_missing_secrets() is
  'Names of the Vault secrets the doqtri-chain-jobs job needs (doqtri_chain_jobs_url, doqtri_cron_secret) that are not stored. Never returns a value.';

-- What the pg_cron job runs every minute: one GET of /api/chain/jobs with
-- the CRON_SECRET bearer, or, while a secret is missing, a WARNING and
-- nothing else. Returns the pg_net request id, or null when nothing was
-- sent. pg_net is asynchronous: the request runs after this returns, and
-- times out after 60 s (the route may run longer; its jobs are leased, so
-- the next minute's run does not repeat them).
create or replace function public.request_chain_jobs_run()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_missing text[] := public.chain_jobs_scheduler_missing_secrets();
begin
  if cardinality(v_missing) > 0 then
    raise warning 'doqtri-chain-jobs: Vault secret(s) % not stored; on-chain removals are not retried by the database, only by the daily Vercel cron and the members screen',
      array_to_string(v_missing, ', ')
      using hint = 'Store them with vault.create_secret(), see doqtri/backend/migrations/20261025090000_chain_jobs_scheduler.sql.';
    return null;
  end if;

  return net.http_get(
    url := (select d.decrypted_secret from vault.decrypted_secrets d
             where d.name = 'doqtri_chain_jobs_url'),
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select d.decrypted_secret from vault.decrypted_secrets d
                     where d.name = 'doqtri_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
end;
$$;

comment on function public.request_chain_jobs_run() is
  'Run by the doqtri-chain-jobs pg_cron job: GETs /api/chain/jobs with the URL and bearer from Vault, or RAISEs WARNING naming the missing secret(s) and sends nothing.';

-- The health signal: `unavailable` when this database has no pg_cron,
-- pg_net or Vault, `missing` when it has them but the job is not scheduled
-- (or not active) or a secret is not stored, and `configured` otherwise.
create or replace function public.chain_jobs_scheduler_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_job     boolean;
  v_missing text[];
begin
  if to_regclass('cron.job') is null
     or to_regnamespace('net') is null
     or to_regclass('vault.decrypted_secrets') is null then
    return jsonb_build_object('status', 'unavailable', 'job', false, 'missing_secrets', '[]'::jsonb);
  end if;

  v_job := exists (
    select 1 from cron.job j
     where j.jobname = 'doqtri-chain-jobs'
       and j.active
  );
  v_missing := public.chain_jobs_scheduler_missing_secrets();

  return jsonb_build_object(
    'status', case when v_job and cardinality(v_missing) = 0 then 'configured' else 'missing' end,
    'job', v_job,
    'missing_secrets', to_jsonb(v_missing)
  );
end;
$$;

comment on function public.chain_jobs_scheduler_health() is
  'SECURITY DEFINER, service_role only. {status: configured | missing | unavailable, job, missing_secrets}: whether the pg_cron chain jobs run can happen. Names only, never secret values.';

revoke all on function public.chain_jobs_scheduler_missing_secrets() from public, anon, authenticated, service_role;
revoke all on function public.request_chain_jobs_run()               from public, anon, authenticated, service_role;
revoke all on function public.chain_jobs_scheduler_health()          from public, anon, authenticated;
grant execute on function public.chain_jobs_scheduler_health() to service_role;


-- ---------------------------------------------------------------------------
-- The job
-- ---------------------------------------------------------------------------

-- Guarded, because not every database has these extensions: hosted
-- Supabase and the Supabase CLI's local stack do; plain Postgres and the
-- PGlite test harness do not. Either way this never fails, and it says
-- what it could not do. The same name again replaces the job, so this is
-- safe to re-run.
do $schedule$
declare
  v_health jsonb;
begin
  begin
    if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
      create extension if not exists pg_cron;
    end if;
    if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net')
       and to_regnamespace('extensions') is not null then
      create extension if not exists pg_net with schema extensions;
    end if;
  exception when others then
    -- Available but not loadable here (pg_cron must be preloaded).
    raise warning 'chain jobs scheduler: could not enable pg_cron/pg_net (%)', sqlerrm;
  end;

  if to_regprocedure('cron.schedule(text, text, text)') is null
     or to_regnamespace('net') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise warning 'chain jobs scheduler: pg_cron, pg_net or Vault is missing in this database, so doqtri-chain-jobs is NOT scheduled; pending on-chain removals are retried only by the daily Vercel cron and the members screen'
      using hint = 'Enable pg_cron and pg_net (Database -> Extensions) and run this migration again, see doqtri/docs/runbooks/registry-editors-rollout.md.';
    return;
  end if;

  perform cron.schedule('doqtri-chain-jobs', '* * * * *', 'select public.request_chain_jobs_run()');

  v_health := public.chain_jobs_scheduler_health();
  if jsonb_array_length(v_health -> 'missing_secrets') > 0 then
    raise warning 'chain jobs scheduler: doqtri-chain-jobs is scheduled but will send nothing until Vault holds %',
      (select string_agg(x, ', ') from jsonb_array_elements_text(v_health -> 'missing_secrets') as x)
      using hint = 'Store them with vault.create_secret(), see doqtri/backend/migrations/20261025090000_chain_jobs_scheduler.sql.';
  end if;
end;
$schedule$;
