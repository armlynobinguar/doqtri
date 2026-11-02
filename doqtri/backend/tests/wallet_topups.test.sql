-- pgTAP tests for 20261101120000_wallet_topups.sql (DOQ-6, WP-4.1): failed
-- first Friendbot top-ups of new smart wallets, queued by the relay and
-- retried by the chain jobs run. Only the service role reaches the queue;
-- a claim leases due rows with a fresh token; one open retry per wallet;
-- testnet only.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/wallet_topups.test.sql
--
-- One transaction, rolled back, so now() is fixed: a row coming due, or a
-- lease running out, is stood in for by moving next_attempt_at back to now().
-- "finish" below is the update the server sends (supabaseWalletTopUpStore
-- .finish in doqtri/frontend/lib/stellar/wallet-topups.ts): by id and claim
-- token, releasing the token.

begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000006a1', 'topup-a@example.com', now()),
  ('00000000-0000-4000-8000-0000000006a2', 'topup-b@example.com', now());

-- Two wallets, one per user.
create temp table w as select
  'C' || repeat('A', 55) as a,
  'C' || repeat('B', 55) as b;
grant select on w to anon, authenticated, service_role;

create function pg_temp.finish(p_id uuid, p_token uuid, p_status text, p_next timestamptz default null) returns integer
language plpgsql as $$
declare v_count integer;
begin
  update public.wallet_topups t
     set status = p_status, last_error = null,
         next_attempt_at = coalesce(p_next, t.next_attempt_at), claim_token = null
   where t.id = p_id and t.claim_token = p_token;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


-- ---------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------

select has_table('public', 'wallet_topups', 'the queue exists');
select is((select relrowsecurity from pg_class where oid = 'public.wallet_topups'::regclass),
  true, 'with RLS on');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'wallet_topups'),
  0, 'and no policies: no client reads or writes it');
select is(
  (select prosecdef from pg_proc where oid = 'public.claim_wallet_topups(integer)'::regprocedure),
  true, 'claim_wallet_topups is security definer');
select is(
  (select proconfig from pg_proc where oid = 'public.claim_wallet_topups(integer)'::regprocedure),
  array['search_path=""'], 'and pins an empty search_path');
select ok(not has_function_privilege('anon', 'public.claim_wallet_topups(integer)', 'execute'),
  'anon cannot claim');
select ok(not has_function_privilege('authenticated', 'public.claim_wallet_topups(integer)', 'execute'),
  'nor can a signed-in user');
select ok(has_function_privilege('service_role', 'public.claim_wallet_topups(integer)', 'execute'),
  'the service role can');


-- ---------------------------------------------------------------------------
-- The service role queues and works it
-- ---------------------------------------------------------------------------

set local role service_role;

select lives_ok(
  $$ insert into public.wallet_topups (user_id, address, last_error)
     values ('00000000-0000-4000-8000-0000000006a1', (select a from w), 'Friendbot is busy.') $$,
  'the relay queues a failed first top-up');
select results_eq(
  $$ select network, status, attempts, claim_token is null, next_attempt_at > now()
       from public.wallet_topups where address = (select a from w) $$,
  $$ values ('testnet'::text, 'pending'::text, 0, true, true) $$,
  'pending on testnet, no attempts yet, due a minute from now');
select throws_ok(
  $$ insert into public.wallet_topups (user_id, address)
     values ('00000000-0000-4000-8000-0000000006a1', (select a from w)) $$,
  '23505', null, 'one open retry per wallet');
select throws_ok(
  $$ insert into public.wallet_topups (user_id, network, address)
     values ('00000000-0000-4000-8000-0000000006a2', 'mainnet', (select b from w)) $$,
  '23514', null, 'never a mainnet wallet');
select throws_ok(
  $$ insert into public.wallet_topups (user_id, address)
     values ('00000000-0000-4000-8000-0000000006a2', 'G' || repeat('B', 55)) $$,
  '23514', null, 'only smart wallets (C...)');

select is((select count(*)::int from public.claim_wallet_topups(10)), 0,
  'nothing is claimed before it comes due');

update public.wallet_topups set next_attempt_at = now() where address = (select a from w);
create temp table claimed as select id, attempts, claim_token, next_attempt_at from public.claim_wallet_topups(10);
select results_eq(
  $$ select attempts, claim_token is not null, next_attempt_at = now() + interval '2 minutes' from claimed $$,
  $$ values (1, true, true) $$,
  'a due retry is claimed: the attempt is counted, a token stamped, a two-minute lease taken');
select is((select claim_token from public.wallet_topups where id = (select id from claimed)),
  (select claim_token from claimed), 'the token is stored on the row');
select is((select count(*)::int from public.claim_wallet_topups(10)), 0,
  'a leased retry is not claimed again');

-- The worker's try failed: back to pending with its backoff.
select is(pg_temp.finish((select id from claimed), (select claim_token from claimed), 'pending', now() + interval '30 seconds'),
  1, 'the claimer records a failed try');
select results_eq(
  $$ select status, claim_token is null, next_attempt_at = now() + interval '30 seconds'
       from public.wallet_topups where id = (select id from claimed) $$,
  $$ values ('pending'::text, true, true) $$,
  'pending again, released, due after its backoff');

-- A stale claim cannot finish a row a later run claimed.
update public.wallet_topups set next_attempt_at = now() where id = (select id from claimed);
create temp table again as select id, attempts, claim_token from public.claim_wallet_topups(10);
select is((select attempts from again), 2, 'the next run counts the second attempt');
select is(pg_temp.finish((select id from claimed), (select claim_token from claimed), 'done'),
  0, 'finishing with the earlier claim matches nothing');
select is(pg_temp.finish((select id from again), (select claim_token from again), 'done'),
  1, 'the current claim finishes it');
select results_eq(
  $$ select status, done_at is not null, claim_token is null from public.wallet_topups where id = (select id from again) $$,
  $$ values ('done'::text, true, true) $$,
  'done, with when');

select lives_ok(
  $$ insert into public.wallet_topups (user_id, address)
     values ('00000000-0000-4000-8000-0000000006a1', (select a from w)) $$,
  'a done retry no longer blocks a new one for the wallet');
update public.wallet_topups set status = 'failed', next_attempt_at = now()
 where address = (select a from w) and status = 'pending';
select is((select count(*)::int from public.claim_wallet_topups(10)), 0,
  'done and failed retries are never claimed again');

reset role;


-- ---------------------------------------------------------------------------
-- Clients reach nothing
-- ---------------------------------------------------------------------------

set local role anon;
select throws_ok($$ select count(*) from public.wallet_topups $$,
  '42501', null, 'anon cannot read the queue');
select throws_ok(
  $$ insert into public.wallet_topups (user_id, address)
     values ('00000000-0000-4000-8000-0000000006a2', (select b from w)) $$,
  '42501', null, 'nor write to it');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000006a1","role":"authenticated"}';
select throws_ok($$ select count(*) from public.wallet_topups $$,
  '42501', null, 'a signed-in user cannot read it, even their own wallet''s');
select throws_ok(
  $$ update public.wallet_topups set status = 'done' $$,
  '42501', null, 'nor mark one done');
reset role;


-- ---------------------------------------------------------------------------
-- Deleting the account drops its retries
-- ---------------------------------------------------------------------------

delete from auth.users where id = '00000000-0000-4000-8000-0000000006a1';
select is((select count(*)::int from public.wallet_topups), 0, 'an account''s retries go with it');

select * from finish();
rollback;
