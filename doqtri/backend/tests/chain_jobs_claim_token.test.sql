-- pgTAP tests for 20261025130000_chain_jobs_claim_token.sql (WP-1.10): a
-- chain job is finished only by the run that claimed it, so a handover
-- re-pointed while the worker is busy with it (D-31) stays open for the new
-- heir.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/chain_jobs_claim_token.test.sql
--
-- One transaction, rolled back. "finish" below is the update the server
-- sends (supabaseChainJobStore.finish): by id and claim token.
--
-- Cast, in the team workspace "gamma":
--   o   owner, deletes their account first
--   h1  the longest-standing admin, so the first heir
--   h2  the next admin

begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000c1', 'gamma-owner@example.com', now()),
  ('00000000-0000-4000-8000-0000000000c2', 'gamma-heir1@example.com', now()),
  ('00000000-0000-4000-8000-0000000000c3', 'gamma-heir2@example.com', now());

insert into public.workspaces (id, name, slug, created_by) values
  ('12000000-0000-4000-8000-000000000001', 'Gamma', 'gamma-wp110', '00000000-0000-4000-8000-0000000000c1');
insert into public.workspace_members (workspace_id, user_id, role, joined_at) values
  ('12000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2', 'admin', now() - interval '2 days'),
  ('12000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c3', 'admin', now() - interval '1 day');

-- What the server sends to record an outcome; returns how many rows it hit.
create function pg_temp.finish(p_id uuid, p_token uuid, p_status text) returns integer
language plpgsql as $$
declare v_count integer;
begin
  update public.workspace_chain_jobs j
     set status = p_status, last_error = null
   where j.id = p_id and j.claim_token = p_token;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

select has_column('public', 'workspace_chain_jobs', 'claim_token', 'jobs carry a claim token');

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000c1' $$,
  'the owner of gamma deletes their account');
select results_eq(
  $$ select user_id, status, claim_token is null from public.workspace_chain_jobs
      where workspace_id = '12000000-0000-4000-8000-000000000001' and kind = 'reassign_owner' $$,
  $$ values ('00000000-0000-4000-8000-0000000000c2'::uuid, 'pending'::text, true) $$,
  'the handover to the first heir is queued, unclaimed');

-- The worker claims it.
create temp table claimed as
  select id, user_id, claim_token from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000001', 10)
   where kind = 'reassign_owner';
select is((select count(*)::int from claimed where claim_token is not null), 1,
  'a claim returns the job with its token');
select is(
  (select j.claim_token from public.workspace_chain_jobs j join claimed c using (id)),
  (select claim_token from claimed),
  'and stores it on the job');

-- While the worker is inside admin_reassign_owner, the heir deletes their
-- account: the handover is re-pointed to the next admin (D-31).
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000c2' $$,
  'the first heir deletes their account while the handover to them is claimed');
select results_eq(
  $$ select user_id, status, attempts, claim_token is null from public.workspace_chain_jobs
      where workspace_id = '12000000-0000-4000-8000-000000000001' and kind = 'reassign_owner' $$,
  $$ values ('00000000-0000-4000-8000-0000000000c3'::uuid, 'pending'::text, 0, true) $$,
  'the re-point names the next admin and voids the claim');

-- The worker comes back and records "done" for the job it claimed.
select is(
  pg_temp.finish((select id from claimed), (select claim_token from claimed), 'done'),
  0, 'finishing with the old claim matches nothing');
select results_eq(
  $$ select user_id, status from public.workspace_chain_jobs
      where workspace_id = '12000000-0000-4000-8000-000000000001' and kind = 'reassign_owner' $$,
  $$ values ('00000000-0000-4000-8000-0000000000c3'::uuid, 'pending'::text) $$,
  'so the handover to the new heir stays open');
select is(
  (select count(*)::int from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000001', 10)
    where kind = 'reassign_owner' and user_id = '00000000-0000-4000-8000-0000000000c3'),
  1, 'and is due at once, for the new heir');

-- A claim whose lease ran out and was claimed again leaves the outcome to
-- the later claim.
create temp table first_claim as
  select id, claim_token from public.workspace_chain_jobs
   where workspace_id = '12000000-0000-4000-8000-000000000001' and kind = 'reassign_owner';
update public.workspace_chain_jobs set next_attempt_at = now()
 where id = (select id from first_claim);
create temp table second_claim as
  select id, claim_token from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000001', 10)
   where kind = 'reassign_owner';
select isnt((select claim_token from second_claim), (select claim_token from first_claim),
  'every claim has a fresh token');
select is(pg_temp.finish((select id from first_claim), (select claim_token from first_claim), 'done'),
  0, 'the run whose lease ran out records nothing');
select is(pg_temp.finish((select id from second_claim), (select claim_token from second_claim), 'done'),
  1, 'the run holding the current claim records its outcome');
select is(
  (select status from public.workspace_chain_jobs where id = (select id from second_claim)),
  'done', 'and the handover is done');

select * from finish();
rollback;
