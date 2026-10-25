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
-- * A revocation queued while an open one is claimed changes what that one
--   means (an admin demoted to editor, then removed while the worker is
--   bringing their role down to editor), and enqueue_chain_revocation()
--   merged it into the open job by doing nothing. It now voids the claim too,
--   and makes a job that was waiting out a retry due at once.
--
-- * Voiding a claim keeps its lease: the call it made may still be in
--   flight, and a second run claiming the job at once could land its own
--   call first and then finish 'done' after the first call overwrote it on
--   the chain. The job comes due when the lease runs out, and its next run
--   reads the chain after the first call has settled.
--
-- * The server finishes a job with `id = ... and claim_token = <its token>`
--   (supabaseChainJobStore.finish in doqtri/frontend/lib/stellar/chain-jobs.ts),
--   and releases the token as it does, so a job holding a token is one a
--   run may be busy with. A job that changed since the claim matches nothing
--   and stays pending, so the new heir's handover (or the removal) runs on
--   the next pass after the lease. A run whose lease ran out and was claimed
--   again likewise leaves the outcome to the later claim.
--
-- * A job records when it was done (done_at). signer_removals_for_document()
--   returns, with each removal, when its revocation was done
--   (`revoked_at`), so the audit page reads a removed member's feed until
--   their wallet actually left the chain's editor list, not only for the day
--   after the removal (doqtri/frontend/lib/stellar/history.ts).
--
-- Safe to run again.

alter table public.workspace_chain_jobs
  add column if not exists claim_token uuid;

alter table public.workspace_chain_jobs
  add column if not exists done_at timestamptz;

comment on column public.workspace_chain_jobs.claim_token is
  'Set by claim_workspace_chain_jobs(); cleared when the job is re-pointed or a revocation is queued onto it, and when the server finishes it. The server finishes a job only while it still holds this token.';
comment on column public.workspace_chain_jobs.done_at is
  'When the job reached done: for a revocation, when the chain held no more than the database for that wallet.';

-- Jobs done before this migration: their last update was the one that did it.
update public.workspace_chain_jobs
   set done_at = updated_at
 where status = 'done' and done_at is null;

create or replace function public.workspace_chain_jobs_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  -- A re-pointed job (D-31) is a new job as far as any open claim goes; a
  -- claim's lease is kept, as its call may still be in flight.
  if new.user_id is distinct from old.user_id then
    if old.claim_token is not null then
      new.next_attempt_at := greatest(old.next_attempt_at, new.next_attempt_at);
    end if;
    new.claim_token := null;
  end if;
  if new.status = 'done' and old.status is distinct from 'done' then
    new.done_at := now();
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

-- As before, but a revocation queued onto an open job voids that job's
-- claim (see above). A claimed job keeps its lease; one waiting out a retry
-- is due at once. Only 'pending' revocations exist in practice; the
-- predicate is the open-job index's.
create or replace function public.enqueue_chain_revocation(p_workspace_id uuid, p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.workspace_chain_jobs as j (workspace_id, kind, user_id, address, network)
  select p_workspace_id, 'revoke', p_user_id, w.address, w.network
    from (
      select s.address, s.network from public.smart_wallets s where s.user_id = p_user_id
      union all
      select a.address, null::text from public.wallet_accounts a where a.user_id = p_user_id
    ) w
  on conflict (workspace_id, kind, (coalesce(address, '')), (coalesce(network, '')))
     where status in ('pending', 'needs_product_owner')
  do update
     set status = 'pending',
         claim_token = null,
         next_attempt_at = case
           when j.claim_token is not null then greatest(j.next_attempt_at, now())
           else least(j.next_attempt_at, now())
         end;
$$;

-- As before, plus when each wallet's revocation reached the chain: the last
-- revocation of that wallet in the workspace done between the removal and
-- its restoration. The last, not the first: one queued before the removal
-- (a demotion) can finish just after it, from what it read before; nothing
-- queues another for a member who is gone until they are restored. Null
-- while none is done. The return type changes, hence the drop.
drop function if exists public.signer_removals_for_document(uuid);
create function public.signer_removals_for_document(p_document_id uuid)
returns table (address text, removed_at timestamptz, restored_at timestamptz, revoked_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.address, r.removed_at, r.restored_at,
         (select max(j.done_at)
            from public.workspace_chain_jobs j
           where j.workspace_id = r.workspace_id
             and j.kind = 'revoke'
             and j.address = a.address
             and j.status = 'done'
             and j.done_at >= r.removed_at
             and (r.restored_at is null or j.done_at <= r.restored_at))
    from public.documents d
    join public.workspace_member_removals r on r.workspace_id = d.workspace_id
    cross join lateral unnest(r.wallet_addresses) as a(address)
   where d.id = p_document_id
   order by r.removed_at, a.address;
$$;

revoke execute on function public.workspace_chain_jobs_before_update() from public, anon, authenticated;
revoke execute on function public.claim_workspace_chain_jobs(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_workspace_chain_jobs(uuid, integer) to service_role;
revoke execute on function public.enqueue_chain_revocation(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.signer_removals_for_document(uuid) from public, anon, authenticated;
grant execute on function public.signer_removals_for_document(uuid) to service_role;
