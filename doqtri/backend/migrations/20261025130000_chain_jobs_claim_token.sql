-- A chain job is finished only by the run that claimed it (WP-1.10).
--
-- claim_workspace_chain_jobs() (20261024150500_workspace_members_management.sql)
-- leases a job for two minutes but keeps it 'pending', and the server then
-- recorded the outcome by the job's id alone. An account deletion can
-- re-point an open handover in that window (D-31): when the heir of a team
-- workspace deletes their account while the worker is inside
-- admin_reassign_owner for them, handle_deleted_user_workspaces() hands the
-- workspace to the next admin and resets the job (new user_id, attempts 0).
-- The worker then marked that re-pointed job 'done', so the chain kept the
-- deleted heir's wallet as owner while the database named the next admin,
-- and no open job was left to correct it.
--
-- * Each claim stamps the job with a fresh claim_token, which the claim
--   returns with the row.
--
-- * Changing a job's subject (its user_id) clears the token, in the
--   existing before-update trigger, so the re-point, or a later one, voids
--   every claim made before it. The same holds when an account deletion
--   sets user_id null on a revocation: that run's outcome is dropped and the
--   job is simply tried again, which is harmless (every job is idempotent
--   on-chain, and the worker reads the chain before it sends).
--
-- * The server finishes a job with `id = ... and claim_token = <its token>`
--   (supabaseChainJobStore.finish in doqtri/frontend/lib/stellar/chain-jobs.ts).
--   A job that changed since the claim matches nothing and stays pending,
--   due at once, so the new heir's handover runs on the next pass. A run
--   whose lease ran out and was claimed again likewise leaves the outcome to
--   the later claim.
--
-- Safe to run again.

alter table public.workspace_chain_jobs
  add column if not exists claim_token uuid;

comment on column public.workspace_chain_jobs.claim_token is
  'Set by claim_workspace_chain_jobs(); cleared when the job is re-pointed. The server finishes a job only while it still holds this token.';

create or replace function public.workspace_chain_jobs_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  -- A re-pointed job (D-31) is a new job as far as any open claim goes.
  if new.user_id is distinct from old.user_id then
    new.claim_token := null;
  end if;
  return new;
end;
$$;

-- As before, plus the claim token. Service role only.
create or replace function public.claim_workspace_chain_jobs(p_workspace_id uuid default null, p_limit integer default 20)
returns setof public.workspace_chain_jobs
language sql
security definer
set search_path = ''
as $$
  update public.workspace_chain_jobs j
     set attempts = j.attempts + 1,
         next_attempt_at = now() + interval '2 minutes',
         claim_token = gen_random_uuid()
   where j.id in (
     select c.id from public.workspace_chain_jobs c
      where c.status = 'pending'
        and c.next_attempt_at <= now()
        and (p_workspace_id is null or c.workspace_id = p_workspace_id)
      order by c.created_at
      limit greatest(1, least(coalesce(p_limit, 20), 100))
        for update skip locked
   )
  returning j.*;
$$;

revoke execute on function public.workspace_chain_jobs_before_update() from public, anon, authenticated;
revoke execute on function public.claim_workspace_chain_jobs(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_workspace_chain_jobs(uuid, integer) to service_role;
