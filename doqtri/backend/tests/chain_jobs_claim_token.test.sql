-- pgTAP tests for 20261025130000_chain_jobs_claim_token.sql (WP-1.10): a
-- chain job is finished only by the run that claimed it, so a handover
-- re-pointed while the worker is busy with it (D-31), or a revocation a
-- removal was queued onto (D-16), stays open; voiding a claim keeps its
-- lease; and the audit page learns when each removal's revocation was done.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/chain_jobs_claim_token.test.sql
--
-- One transaction, rolled back, so now() is fixed: an expired lease is
-- stood in for by moving next_attempt_at back to now(). "finish" below is
-- the update the server sends (supabaseChainJobStore.finish): by id and
-- claim token, releasing the token.
--
-- Cast, in the team workspace "gamma":
--   o   owner, deletes their account first
--   h1  the longest-standing admin, so the first heir
--   h2  the next admin
--   h3  the admin after that
-- and in the team workspace "delta":
--   d   owner
--   m   an admin who signs with Freighter, demoted and then removed

begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000c1', 'gamma-owner@example.com', now()),
  ('00000000-0000-4000-8000-0000000000c2', 'gamma-heir1@example.com', now()),
  ('00000000-0000-4000-8000-0000000000c3', 'gamma-heir2@example.com', now()),
  ('00000000-0000-4000-8000-0000000000c4', 'gamma-heir3@example.com', now()),
  ('00000000-0000-4000-8000-0000000000d1', 'delta-owner@example.com', now()),
  ('00000000-0000-4000-8000-0000000000d2', 'delta-admin@example.com', now());

insert into public.workspaces (id, name, slug, created_by) values
  ('12000000-0000-4000-8000-000000000001', 'Gamma', 'gamma-wp110', '00000000-0000-4000-8000-0000000000c1'),
  ('12000000-0000-4000-8000-000000000002', 'Delta', 'delta-wp110', '00000000-0000-4000-8000-0000000000d1');
insert into public.workspace_members (workspace_id, user_id, role, joined_at) values
  ('12000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2', 'admin', now() - interval '3 days'),
  ('12000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c3', 'admin', now() - interval '2 days'),
  ('12000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', 'admin', now() - interval '1 day'),
  ('12000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000d2', 'admin', now() - interval '1 day');
insert into public.wallet_accounts (address, user_id) values
  ('G' || repeat('Q', 55), '00000000-0000-4000-8000-0000000000d2');
insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('12000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d1',
   '12000000-0000-4000-8000-000000000002', 'Delta plan', '# Delta plan');

-- What the server sends to record an outcome; returns how many rows it hit.
create function pg_temp.finish(p_id uuid, p_token uuid, p_status text, p_next timestamptz default null) returns integer
language plpgsql as $$
declare v_count integer;
begin
  update public.workspace_chain_jobs j
     set status = p_status, last_error = null,
         next_attempt_at = coalesce(p_next, j.next_attempt_at), claim_token = null
   where j.id = p_id and j.claim_token = p_token;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The lease of every open job of a workspace runs out.
create function pg_temp.expire(p_workspace uuid) returns void
language sql as $$
  update public.workspace_chain_jobs set next_attempt_at = now()
   where workspace_id = p_workspace and status = 'pending';
$$;

select has_column('public', 'workspace_chain_jobs', 'claim_token', 'jobs carry a claim token');
select has_column('public', 'workspace_chain_jobs', 'done_at', 'and when they were done');


-- ---------------------------------------------------------------------------
-- A handover re-pointed during its call (D-31)
-- ---------------------------------------------------------------------------

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
select ok(
  (select next_attempt_at > now() from public.workspace_chain_jobs where id = (select id from claimed)),
  'but keeps the claim''s lease, as its call may still be in flight');
select is(
  (select count(*)::int from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000001', 10)
    where kind = 'reassign_owner'),
  0, 'so a run straight after the re-point claims nothing');

-- The worker comes back and records "done" for the job it claimed.
select is(
  pg_temp.finish((select id from claimed), (select claim_token from claimed), 'done'),
  0, 'finishing with the old claim matches nothing');
select results_eq(
  $$ select user_id, status from public.workspace_chain_jobs
      where workspace_id = '12000000-0000-4000-8000-000000000001' and kind = 'reassign_owner' $$,
  $$ values ('00000000-0000-4000-8000-0000000000c3'::uuid, 'pending'::text) $$,
  'so the handover to the new heir stays open');

select pg_temp.expire('12000000-0000-4000-8000-000000000001');
create temp table second_claim as
  select id, user_id, claim_token from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000001', 10)
   where kind = 'reassign_owner';
select results_eq(
  $$ select user_id from second_claim $$,
  $$ values ('00000000-0000-4000-8000-0000000000c3'::uuid) $$,
  'and is claimed for the new heir once the lease runs out');

-- That run fails and backs off for an hour; finishing releases its token.
select is(
  pg_temp.finish((select id from second_claim), (select claim_token from second_claim), 'pending', now() + interval '1 hour'),
  1, 'a run holding the claim records a retry');
select is(
  (select claim_token from public.workspace_chain_jobs where id = (select id from second_claim)),
  null, 'and releases the token as it does');

-- A re-point of a job no run holds is due at once, backoff or not.
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000c3' $$,
  'the second heir deletes their account while the handover waits out its retry');
create temp table third_claim as
  select id, user_id, claim_token from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000001', 10)
   where kind = 'reassign_owner';
select results_eq(
  $$ select user_id from third_claim $$,
  $$ values ('00000000-0000-4000-8000-0000000000c4'::uuid) $$,
  'a re-point of an unclaimed handover is due at once, for the third heir');

-- A claim whose lease ran out and was claimed again leaves the outcome to
-- the later claim.
select pg_temp.expire('12000000-0000-4000-8000-000000000001');
create temp table fourth_claim as
  select id, claim_token from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000001', 10)
   where kind = 'reassign_owner';
select isnt((select claim_token from fourth_claim), (select claim_token from third_claim),
  'every claim has a fresh token');
select is(pg_temp.finish((select id from third_claim), (select claim_token from third_claim), 'done'),
  0, 'the run whose lease ran out records nothing');
select is(pg_temp.finish((select id from fourth_claim), (select claim_token from fourth_claim), 'done'),
  1, 'the run holding the current claim records its outcome');
select results_eq(
  $$ select status, done_at is not null, claim_token is null from public.workspace_chain_jobs
      where id = (select id from fourth_claim) $$,
  $$ values ('done'::text, true, true) $$,
  'and the handover is done, with when, and no claim left on it');


-- ---------------------------------------------------------------------------
-- A removal queued onto a revocation during its call (D-16)
-- ---------------------------------------------------------------------------

select lives_ok(
  $$ update public.workspace_members set role = 'editor'
      where workspace_id = '12000000-0000-4000-8000-000000000002'
        and user_id = '00000000-0000-4000-8000-0000000000d2' $$,
  'the admin of delta is demoted to editor');
select results_eq(
  $$ select address, status from public.workspace_chain_jobs
      where workspace_id = '12000000-0000-4000-8000-000000000002' and kind = 'revoke' $$,
  $$ values ('G' || repeat('Q', 55), 'pending'::text) $$,
  'which queues a revocation of their wallet');

-- The worker claims it and reads their database role: editor.
create temp table revoke_claim as
  select id, claim_token from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000002', 10)
   where kind = 'revoke';
select is((select count(*)::int from revoke_claim), 1, 'the worker claims the revocation');

-- While it brings their on-chain role down to editor, they are removed.
select lives_ok(
  $$ delete from public.workspace_members
      where workspace_id = '12000000-0000-4000-8000-000000000002'
        and user_id = '00000000-0000-4000-8000-0000000000d2' $$,
  'they are removed while the revocation is claimed');
select results_eq(
  $$ select id, status, claim_token is null, next_attempt_at > now() from public.workspace_chain_jobs
      where workspace_id = '12000000-0000-4000-8000-000000000002' and kind = 'revoke' $$,
  $$ select id, 'pending'::text, true, true from revoke_claim $$,
  'the removal is queued onto the open job, voiding its claim and keeping its lease');
select is(pg_temp.finish((select id from revoke_claim), (select claim_token from revoke_claim), 'done'),
  0, 'so the run that read "editor" records nothing');
select is(
  (select count(*)::int from public.workspace_chain_jobs
    where workspace_id = '12000000-0000-4000-8000-000000000002' and kind = 'revoke' and status = 'pending'),
  1, 'and the revocation stays open');
select is(
  (select count(*)::int from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000002', 10)),
  0, 'not claimable while the voided claim''s lease runs');

select pg_temp.expire('12000000-0000-4000-8000-000000000002');
create temp table revoke_retry as
  select id, claim_token from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000002', 10);
select is(pg_temp.finish((select id from revoke_retry), (select claim_token from revoke_retry), 'pending', now() + interval '1 hour'),
  1, 'once it runs out, the next run takes it, and fails with a backoff');

-- Added back and removed again while that revocation waits out its retry.
insert into public.workspace_members (workspace_id, user_id, role) values
  ('12000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000d2', 'editor');
delete from public.workspace_members
 where workspace_id = '12000000-0000-4000-8000-000000000002'
   and user_id = '00000000-0000-4000-8000-0000000000d2';
create temp table revoke_due as
  select id, claim_token from public.claim_workspace_chain_jobs('12000000-0000-4000-8000-000000000002', 10);
select is((select count(*)::int from revoke_due), 1,
  'a removal queued onto a job no run holds makes it due at once');
select is(pg_temp.finish((select id from revoke_due), (select claim_token from revoke_due), 'done'),
  1, 'and that run records the revocation as done');


-- ---------------------------------------------------------------------------
-- signer_removals_for_document: when the revocation was done
-- ---------------------------------------------------------------------------

-- now() is fixed, so the two removals are moved into the past: the first
-- three days ago, lifted two days ago; the second a day ago. A revocation
-- done during the first is added, and the one just done stands for the
-- second.
update public.workspace_member_removals r
   set removed_at = now() - interval '3 days', restored_at = now() - interval '2 days'
 where r.workspace_id = '12000000-0000-4000-8000-000000000002' and r.restored_at is not null;
update public.workspace_member_removals r
   set removed_at = now() - interval '1 day'
 where r.workspace_id = '12000000-0000-4000-8000-000000000002' and r.restored_at is null;
insert into public.workspace_chain_jobs (workspace_id, kind, address, status, done_at)
values ('12000000-0000-4000-8000-000000000002', 'revoke', 'G' || repeat('Q', 55), 'done', now() - interval '60 hours');

select results_eq(
  $$ select address, removed_at, revoked_at
       from public.signer_removals_for_document('12000000-0000-4000-8000-0000000000aa') $$,
  $$ values ('G' || repeat('Q', 55), now() - interval '3 days', now() - interval '60 hours'),
            ('G' || repeat('Q', 55), now() - interval '1 day', now()) $$,
  'each removal gets the revocation done between it and its restoration');

update public.workspace_chain_jobs set done_at = now() - interval '1 hour'
 where workspace_id = '12000000-0000-4000-8000-000000000002' and kind = 'revoke'
   and done_at = now() - interval '60 hours';
select results_eq(
  $$ select revoked_at is null
       from public.signer_removals_for_document('12000000-0000-4000-8000-0000000000aa') $$,
  $$ values (true), (false) $$,
  'a revocation done after a restoration counts for no earlier removal');
-- The second removal's window holds both: the later one is when the chain
-- held what the database does.
select is(
  (select max(revoked_at) from public.signer_removals_for_document('12000000-0000-4000-8000-0000000000aa')),
  now(), 'of several revocations done since a removal, the last counts');

select ok(not has_function_privilege('authenticated', 'public.signer_removals_for_document(uuid)', 'execute'),
  'authenticated still cannot call signer_removals_for_document');
select ok(has_function_privilege('service_role', 'public.signer_removals_for_document(uuid)', 'execute'),
  'the service role still can');

select * from finish();
rollback;
